/// A configured usage budget's current status, distilled from the daemon's
/// `usage {budget:true}` reply (and refreshed in-place by `UsageWarning`
/// pushes). Carries just the fields the on-screen usage chip needs.
#[derive(Clone, Debug, Default)]
pub(crate) struct UsageBudget {
    pub name: String,
    /// Fraction used, e.g. 0.8 for 80%.
    pub percent_used: f64,
    /// Warning thresholds already crossed this period, as fractions.
    pub crossed_warn_at: Vec<f64>,
    /// Whether spend has reached or exceeded the limit.
    pub over_limit: bool,
    /// Spend against the current pace allowance, when the budget configures a
    /// pace. Measured over the pace sub-window, not the budget period.
    pub pace: Option<UsageLevel>,
}

/// One measured limit: a budget's period cap, or its pace allowance.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct UsageLevel {
    /// Fraction used, e.g. 0.8 for 80%.
    pub percent_used: f64,
    pub crossed_warn_at: Vec<f64>,
    pub over_limit: bool,
}

impl UsageLevel {
    pub(crate) fn in_warning(&self) -> bool {
        self.over_limit || !self.crossed_warn_at.is_empty()
    }
}

/// Which limit a `usage_warning` push refers to — and, via [`BudgetFocus`],
/// which limit the usage chip tracks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageScope {
    Cap,
    Pace,
}

impl UsageScope {
    /// Canonical token used in `:view budget <target>` and prefs.
    pub(crate) fn as_token(self) -> &'static str {
        match self {
            UsageScope::Cap => "cap",
            UsageScope::Pace => "pace",
        }
    }

    /// Parse a scope token. `budget` is accepted for `cap` because that is the
    /// daemon's wire name for the period limit.
    pub(crate) fn from_token(token: &str) -> Option<Self> {
        match token.to_ascii_lowercase().as_str() {
            "cap" | "budget" => Some(UsageScope::Cap),
            "pace" => Some(UsageScope::Pace),
            _ => None,
        }
    }
}

/// Which budget — and which of its limits — the usage chip follows.
///
/// The default tracks whatever is closest to binding, which is the right
/// answer when nothing paces itself. Once a budget configures a pace, its two
/// limits answer different questions ("am I on track for the week?" vs "how
/// much is left today?") and only the user knows which one they steer by, so
/// the choice is pinnable.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct BudgetFocus {
    /// Budget to follow, matched case-insensitively by name. `None` follows
    /// whichever configured budget is closest to its limit.
    pub name: Option<String>,
    /// Limit within that budget. `None` follows whichever binds first.
    pub scope: Option<UsageScope>,
}

impl BudgetFocus {
    pub(crate) fn scoped(scope: UsageScope) -> Self {
        Self {
            name: None,
            scope: Some(scope),
        }
    }

    pub(crate) fn named(name: &str) -> Self {
        Self {
            name: Some(name.to_string()),
            scope: None,
        }
    }

    /// Canonical token used in the `:view budget <target>` command and prefs.
    pub(crate) fn as_token(&self) -> String {
        match (&self.name, self.scope) {
            (None, None) => "auto".to_string(),
            (None, Some(scope)) => scope.as_token().to_string(),
            (Some(name), None) => name.clone(),
            (Some(name), Some(scope)) => format!("{name}:{}", scope.as_token()),
        }
    }

    /// Parse a command/pref token: `auto`, a bare scope, a budget name, or a
    /// `<name>:<scope>` pair.
    ///
    /// `auto`, `cap` and `pace` are reserved, so a budget actually named one of
    /// them has to be written with an explicit scope (`pace:cap`).
    pub(crate) fn from_token(token: &str) -> Option<Self> {
        let token = token.trim();
        if let Some((name, scope)) = token.split_once(':') {
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            return Some(Self {
                name: Some(name.to_string()),
                scope: Some(UsageScope::from_token(scope.trim())?),
            });
        }
        match token.to_ascii_lowercase().as_str() {
            "" => None,
            "auto" => Some(Self::default()),
            "cap" | "budget" => Some(Self::scoped(UsageScope::Cap)),
            "pace" => Some(Self::scoped(UsageScope::Pace)),
            _ => Some(Self::named(token)),
        }
    }
}

/// Read a `UsageLevel` out of a budget payload's `pace` object. Returns `None`
/// for anything that isn't an object, so a daemon without pacing (or a budget
/// that configures none) simply reports no pace.
pub(crate) fn usage_level_from_json(value: &serde_json::Value) -> Option<UsageLevel> {
    if !value.is_object() {
        return None;
    }
    Some(UsageLevel {
        percent_used: value
            .get("percent_used")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0),
        crossed_warn_at: value
            .get("crossed_warn_at")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(serde_json::Value::as_f64).collect())
            .unwrap_or_default(),
        over_limit: value
            .get("over_limit")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

impl UsageBudget {
    /// True once any warning threshold has been crossed (or either limit is
    /// over) — the signal that gates warning styling and the "only past a
    /// warning level" visibility mode.
    ///
    /// The *union* of both limits, deliberately: `warn_at` and `pace_warn_at`
    /// are configured independently, so a pace past its own threshold is a
    /// warning even while the period cap is still calm. Narrowing this to the
    /// headline would let the cap hide a warning the user asked to see.
    pub(crate) fn in_warning(&self) -> bool {
        self.cap().in_warning() || self.pace.as_ref().is_some_and(UsageLevel::in_warning)
    }

    /// This budget's period cap as a standalone level.
    fn cap(&self) -> UsageLevel {
        UsageLevel {
            percent_used: self.percent_used,
            crossed_warn_at: self.crossed_warn_at.clone(),
            over_limit: self.over_limit,
        }
    }

    /// The constraint that binds first: the pace when it is the more pressing
    /// of the two, otherwise the cap. This is the figure the usage chip
    /// renders, extending "show the most pressing constraint" to budgets that
    /// pace themselves.
    pub(crate) fn headline(&self) -> UsageLevel {
        match self.pace.as_ref() {
            Some(pace) if self.pace_leads(pace) => pace.clone(),
            _ => self.cap(),
        }
    }

    /// [`Self::headline`]'s percentage without the vector clones. The chip's
    /// "most urgent budget" scan runs this on every frame, once per budget.
    pub(crate) fn headline_percent(&self) -> f64 {
        match self.pace.as_ref() {
            Some(pace) if self.pace_leads(pace) => pace.percent_used,
            _ => self.percent_used,
        }
    }

    /// Whether the pace outranks the period cap. Split out so `headline` and
    /// `headline_percent` cannot drift apart.
    ///
    /// A limit past one of *its own* thresholds outranks a limit that isn't,
    /// whatever the raw percentages: with `warn_at = [0.8]` and
    /// `pace_warn_at = [0.5]`, a 55% pace is the live warning and a 60% cap is
    /// not. Percentage only breaks the tie when both — or neither — are
    /// warning.
    fn pace_leads(&self, pace: &UsageLevel) -> bool {
        let cap_warning = self.over_limit || !self.crossed_warn_at.is_empty();
        match (pace.in_warning(), cap_warning) {
            (true, false) => true,
            (false, true) => false,
            _ => pace.percent_used > self.percent_used,
        }
    }

    /// The level this budget reports under `scope`: its period cap, its pace,
    /// or — with no scope pinned — [`Self::headline`].
    ///
    /// A budget that configures no pace falls back to its cap, so pinning
    /// `pace` never blanks the chip for budgets that don't pace themselves.
    pub(crate) fn level(&self, scope: Option<UsageScope>) -> UsageLevel {
        match scope {
            None => self.headline(),
            Some(UsageScope::Cap) => self.cap(),
            Some(UsageScope::Pace) => self.pace.clone().unwrap_or_else(|| self.cap()),
        }
    }

    /// [`Self::level`]'s percentage without the vector clones, for the
    /// per-frame scan that ranks budgets.
    pub(crate) fn level_percent(&self, scope: Option<UsageScope>) -> f64 {
        match scope {
            None => self.headline_percent(),
            Some(UsageScope::Cap) => self.percent_used,
            Some(UsageScope::Pace) => self
                .pace
                .as_ref()
                .map_or(self.percent_used, |pace| pace.percent_used),
        }
    }

    /// Whether [`Self::level`] reports the pace rather than the period cap.
    /// The chip labels those: a pace percentage read as a period percentage is
    /// badly misleading in either direction.
    pub(crate) fn level_is_pace(&self, scope: Option<UsageScope>) -> bool {
        match scope {
            Some(UsageScope::Cap) => false,
            Some(UsageScope::Pace) => self.pace.is_some(),
            None => self.pace.as_ref().is_some_and(|pace| self.pace_leads(pace)),
        }
    }
}

/// When the usage chip is shown on the input border.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum UsageDisplay {
    /// Never show the chip; usage warnings fall back to a notification.
    #[default]
    Off,
    /// Always show the chip once budget data is known.
    Always,
    /// Only show the chip once a warning threshold has been crossed.
    Warn,
}

impl UsageDisplay {
    /// Canonical token used in the `:view usage <mode>` command and prefs.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            UsageDisplay::Off => "off",
            UsageDisplay::Always => "always",
            UsageDisplay::Warn => "warn",
        }
    }

    /// Parse a command/pref token. `on` is accepted as an alias for `always`
    /// so the boolean `:view` muscle-memory (and older prefs) keep working.
    pub(crate) fn from_token(token: &str) -> Option<Self> {
        match token {
            "off" => Some(UsageDisplay::Off),
            "always" | "on" => Some(UsageDisplay::Always),
            "warn" => Some(UsageDisplay::Warn),
            _ => None,
        }
    }

    /// Next mode in the off → always → warn → off cycle (submenu Enter / toggle).
    pub(crate) fn cycled(self) -> Self {
        match self {
            UsageDisplay::Off => UsageDisplay::Always,
            UsageDisplay::Always => UsageDisplay::Warn,
            UsageDisplay::Warn => UsageDisplay::Off,
        }
    }
}
