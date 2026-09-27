use shore_common::protocol::operations::ClaudePlanWindow;

#[derive(Clone, Debug, Default)]
pub(crate) struct UsageBudget {
    pub name: String,
    pub percent_used: f64,
    pub crossed_warn_at: Vec<f64>,
    pub over_limit: bool,
    pub pace: Option<UsageLevel>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct UsageLevel {
    pub percent_used: f64,
    pub crossed_warn_at: Vec<f64>,
    pub over_limit: bool,
}

impl UsageLevel {
    pub(crate) fn in_warning(&self) -> bool {
        self.over_limit || !self.crossed_warn_at.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageScope {
    Cap,
    Pace,
}

impl UsageScope {
    pub(crate) fn as_token(self) -> &'static str {
        match self {
            UsageScope::Cap => "cap",
            UsageScope::Pace => "pace",
        }
    }

    pub(crate) fn from_token(token: &str) -> Option<Self> {
        match token.to_ascii_lowercase().as_str() {
            "cap" | "budget" => Some(UsageScope::Cap),
            "pace" => Some(UsageScope::Pace),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct BudgetFocus {
    pub name: Option<String>,
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
            name: Some(name.to_owned()),
            scope: None,
        }
    }

    pub(crate) fn as_token(&self) -> String {
        match (&self.name, self.scope) {
            (None, None) => "auto".to_owned(),
            (None, Some(scope)) => scope.as_token().to_owned(),
            (Some(name), None) => name.clone(),
            (Some(name), Some(scope)) => format!("{name}:{}", scope.as_token()),
        }
    }

    pub(crate) fn from_token(token: &str) -> Option<Self> {
        let trimmed_token = token.trim();
        if let Some((name, scope)) = trimmed_token.split_once(':') {
            let trimmed_name = name.trim();
            if trimmed_name.is_empty() {
                return None;
            }
            return Some(Self {
                name: Some(trimmed_name.to_owned()),
                scope: Some(UsageScope::from_token(scope.trim())?),
            });
        }
        match trimmed_token.to_ascii_lowercase().as_str() {
            "" => None,
            "auto" => Some(Self::default()),
            "cap" | "budget" => Some(Self::scoped(UsageScope::Cap)),
            "pace" => Some(Self::scoped(UsageScope::Pace)),
            _ => Some(Self::named(token)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanWindow {
    FiveHour,
    SevenDay,
}

impl PlanWindow {
    pub(crate) fn label(self) -> &'static str {
        match self {
            PlanWindow::FiveHour => "5h",
            PlanWindow::SevenDay => "7d",
        }
    }

    pub(crate) fn from_token(token: &str) -> Option<Self> {
        match token {
            "five_hour" => Some(PlanWindow::FiveHour),
            "seven_day" => Some(PlanWindow::SevenDay),
            _ => None,
        }
    }
}

impl From<ClaudePlanWindow> for PlanWindow {
    fn from(window: ClaudePlanWindow) -> Self {
        match window {
            ClaudePlanWindow::FiveHour => PlanWindow::FiveHour,
            ClaudePlanWindow::SevenDay => PlanWindow::SevenDay,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PlanLimit {
    pub window: PlanWindow,
    pub level: UsageLevel,
}

pub(crate) fn plan_limits_from_json(value: &serde_json::Value) -> Option<Vec<PlanLimit>> {
    let limits: Vec<PlanLimit> = value
        .get("windows")?
        .as_array()?
        .iter()
        .filter_map(|window| {
            Some(PlanLimit {
                window: PlanWindow::from_token(window.get("window")?.as_str()?)?,
                level: usage_level_from_json(window)?,
            })
        })
        .collect();
    (!limits.is_empty()).then_some(limits)
}

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
    pub(crate) fn in_warning(&self) -> bool {
        self.cap().in_warning() || self.pace.as_ref().is_some_and(UsageLevel::in_warning)
    }

    fn cap(&self) -> UsageLevel {
        UsageLevel {
            percent_used: self.percent_used,
            crossed_warn_at: self.crossed_warn_at.clone(),
            over_limit: self.over_limit,
        }
    }

    pub(crate) fn headline(&self) -> UsageLevel {
        match self.pace.as_ref() {
            Some(pace) if self.pace_leads(pace) => pace.clone(),
            _ => self.cap(),
        }
    }

    pub(crate) fn headline_percent(&self) -> f64 {
        match self.pace.as_ref() {
            Some(pace) if self.pace_leads(pace) => pace.percent_used,
            _ => self.percent_used,
        }
    }

    fn pace_leads(&self, pace: &UsageLevel) -> bool {
        let cap_warning = self.over_limit || !self.crossed_warn_at.is_empty();
        match (pace.in_warning(), cap_warning) {
            (true, false) => true,
            (false, true) => false,
            _ => pace.percent_used > self.percent_used,
        }
    }

    pub(crate) fn level(&self, scope: Option<UsageScope>) -> UsageLevel {
        match scope {
            None => self.headline(),
            Some(UsageScope::Cap) => self.cap(),
            Some(UsageScope::Pace) => self.pace.clone().unwrap_or_else(|| self.cap()),
        }
    }

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

    pub(crate) fn level_is_pace(&self, scope: Option<UsageScope>) -> bool {
        match scope {
            Some(UsageScope::Cap) => false,
            Some(UsageScope::Pace) => self.pace.is_some(),
            None => self.pace.as_ref().is_some_and(|pace| self.pace_leads(pace)),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum UsageDisplay {
    #[default]
    Off,
    Always,
    Warn,
}

impl UsageDisplay {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            UsageDisplay::Off => "off",
            UsageDisplay::Always => "always",
            UsageDisplay::Warn => "warn",
        }
    }

    pub(crate) fn from_token(token: &str) -> Option<Self> {
        match token {
            "off" => Some(UsageDisplay::Off),
            "always" | "on" => Some(UsageDisplay::Always),
            "warn" => Some(UsageDisplay::Warn),
            _ => None,
        }
    }

    pub(crate) fn cycled(self) -> Self {
        match self {
            UsageDisplay::Off => UsageDisplay::Always,
            UsageDisplay::Always => UsageDisplay::Warn,
            UsageDisplay::Warn => UsageDisplay::Off,
        }
    }
}
