use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shore_config::app::DreamingConfig;
use shore_config::cron::CronSchedule;
use shore_config::{
    character_data_dir, character_memory_dir, character_workspace_dir, LoadedConfig, SOUL_FILE,
    USER_FILE,
};

use shore_ledger::{CallType, LedgerClient};
use shore_llm::types::{GenerateResponse, LlmRequest};
use tokio::fs;
use tracing::{debug, info, warn};

use crate::convert::{u32_to_f32, usize_to_f32};
use crate::memory::deferred_edits::MEMORY_INDEX_FILE;
use crate::memory::markdown_store::{MarkdownEntry, MarkdownMemoryStore, MarkdownStoreError};
use crate::tools::context::SharedToolContext;
use crate::tools::{self as tool_system, ToolContext};

const MIN_PROMOTION_SCORE: f32 = 0.60;
const MIN_CANDIDATE_LEN: usize = 18;
const MAX_CANDIDATES: usize = 80;
const MAX_DIARY_ITEMS: usize = 12;
const MAX_INDEX_FILES: usize = 40;
const MAX_RECENT_INDEX_FILES: usize = 12;
const MAX_INDEX_THROUGHLINES: usize = 16;
const DREAM_DATA_DIR: &str = "dreams";
const DREAM_REPORTS_DIR: &str = "reports";
const DREAM_STATE_FILE: &str = "state.json";
const DREAM_STATE_REL: &str = "dreams/state.json";
const LEGACY_DREAM_STATE_REL: &str = ".dreams/state.json";
const DREAM_DIARY_HEADER: &str = "# Dreams\n\nThis file is the human-readable Dream Diary for Shore's memory consolidation system.\n\nIt is not long-term memory.\nDurable notes live in ordinary markdown memory files.\n`MEMORY.md` is the prompt-visible memory index.\nMachine-facing dreaming state lives under the character data directory in `dreams/*.json`, not in markdown memory.\n\nEditing or deleting Dream Diary sections does not directly change memory notes or the prompt-visible index.\n\n";

#[derive(Debug, thiserror::Error)]
pub enum DreamingError {
    #[error("io: {0}")]
    Io(String),
    #[error("memory: {0}")]
    Memory(String),
    #[error("config: {0}")]
    Config(String),
    #[error("llm: {0}")]
    Llm(String),
    #[error("invalid schedule: {0}")]
    Schedule(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DreamState {
    pub last_run_at: Option<String>,
    pub runs: u64,
    #[serde(default)]
    pub last_candidates_path: Option<String>,
    #[serde(default)]
    pub last_signals_path: Option<String>,
    #[serde(default)]
    pub last_promotions_path: Option<String>,
    #[serde(default)]
    pub seen_candidates: BTreeMap<String, DreamSeenState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DreamSeenState {
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub recall_count: u32,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DreamEvidence {
    pub source: String,
    pub line: Option<usize>,
    pub source_kind: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DreamGate {
    pub name: String,
    pub passed: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamCandidate {
    pub id: String,
    pub text: String,
    pub source: String,
    pub line: Option<usize>,
    pub source_kind: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub recall_count: u32,
    pub unique_source_count: usize,
    pub unique_query_count: u32,
    pub theme_hits: Vec<String>,
    pub recency_score: f32,
    pub durability_score: f32,
    pub specificity_score: f32,
    pub promotion_score: f32,
    pub score: f32,
    pub gates: Vec<DreamGate>,
    pub promote: bool,
    pub decision_reason: String,
    pub evidence: Vec<DreamEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamTheme {
    pub theme: String,
    pub hits: usize,
    pub candidate_ids: Vec<String>,
    pub example: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamPromotion {
    pub text: String,
    pub score: f32,
    pub evidence: Vec<DreamEvidence>,
    pub gates_passed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamRejection {
    pub text: String,
    pub score: f32,
    pub reason: String,
    pub failed_gates: Vec<String>,
    pub evidence: Vec<DreamEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamPhaseSummary {
    pub phase: String,
    pub summary: String,
    pub candidate_count: usize,
    pub promoted_count: usize,
    pub rejected_count: usize,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamSweepResult {
    pub character: String,
    pub dry_run: bool,
    pub ran_at: String,
    #[serde(default)]
    pub mode: String,
    pub phase_summaries: Vec<DreamPhaseSummary>,
    pub candidate_count: usize,
    pub indexed_count: usize,
    pub promoted_count: usize,
    pub rejected_count: usize,
    pub candidates: Vec<DreamCandidate>,
    pub rem_themes: Vec<DreamTheme>,
    pub promotions: Vec<DreamPromotion>,
    pub rejected: Vec<DreamRejection>,
    pub indexed: Vec<String>,
    pub promoted: Vec<String>,
    pub paths_written: Vec<String>,
    pub would_write_paths: Vec<String>,
    pub staged_path: Option<String>,
    pub dreams_path: Option<String>,
    pub memory_path: Option<String>,
    #[serde(default)]
    pub inspected: Vec<String>,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub tools_used: Vec<String>,
    #[serde(default)]
    pub tool_rounds: u32,
    #[serde(default)]
    pub audit_appended: bool,
    #[serde(default)]
    pub final_report: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DreamStatus {
    pub character: String,
    pub enabled: bool,
    pub frequency: String,
    pub last_run_at: Option<String>,
    pub due: bool,
    pub state_path: String,
    pub dreams_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LightPhaseOutput {
    sources_reviewed: usize,
    candidates_staged: usize,
    duplicates_ignored: usize,
    generated_sources_ignored: usize,
    candidates: Vec<DreamCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemPhaseOutput {
    themes: Vec<DreamTheme>,
    reinforcement_signals: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeepPhaseOutput {
    candidates: Vec<DreamCandidate>,
    promoted: Vec<DreamPromotion>,
    rejected: Vec<DreamRejection>,
}

type PhaseReportPaths<'path> = (&'path Path, &'path Path, &'path Path);

pub async fn dream_status(
    data_dir: &Path,
    config_dir: &Path,
    character: &str,
    cfg: &DreamingConfig,
) -> Result<DreamStatus, DreamingError> {
    let _ignored = character_memory_dir(config_dir, character);
    let state = read_state(data_dir, config_dir, character).await?;
    let due = cfg.enabled && is_due(cfg, state.last_run_at.as_deref())?;
    Ok(DreamStatus {
        character: character.to_owned(),
        enabled: cfg.enabled,
        frequency: cfg.frequency.clone(),
        last_run_at: state.last_run_at,
        due,
        state_path: dream_state_path(data_dir, character).display().to_string(),
        dreams_path: crate::memory::dreams_log::dreams_log_path(data_dir, character)
            .display()
            .to_string(),
    })
}

/// Whether a scheduled (non-forced, non-dry-run) sweep is currently due per
/// the cron schedule and the persisted `last_run_at`. Lets the autonomy
/// manager skip pre-sweep work (e.g. pre-dream compaction) on ticks where
/// `run_librarian_sweep` would decline anyway.
pub async fn scheduled_sweep_due(
    loaded_config: &LoadedConfig,
    data_dir: &Path,
    character: &str,
) -> Result<bool, DreamingError> {
    let cfg = &loaded_config.app.memory.dreaming;
    let state = read_state(data_dir, &loaded_config.dirs.config, character).await?;
    is_due(cfg, state.last_run_at.as_deref())
}

pub async fn run_librarian_sweep(
    loaded_config: &LoadedConfig,
    data_dir: &Path,
    llm_client: &LedgerClient,
    character: &str,
    cached_request: Option<&LlmRequest>,
    dry_run: bool,
    force: bool,
) -> Result<Option<DreamSweepResult>, DreamingError> {
    let Some(setup) =
        prepare_librarian_sweep(loaded_config, data_dir, character, dry_run, force).await?
    else {
        return Ok(None);
    };

    // The librarian commits its changes through the exec tool, so the
    // workspace must be a git repository before the pass starts.
    if !dry_run {
        crate::tools::workspace::ensure_workspace_git_repo_best_effort(
            &setup.workspace_dir,
            character,
            "dreaming",
        )
        .await;
    }

    let (mut request, tool_ctx, max_tool_iterations) = prepare_librarian_call(
        loaded_config,
        data_dir,
        llm_client,
        character,
        cached_request,
        dry_run,
        &setup.ran_at,
    )?;

    info!(
        character,
        dry_run,
        ?max_tool_iterations,
        "Dreaming: starting AI librarian pass"
    );

    let loop_result = run_librarian_loop(
        llm_client,
        loaded_config,
        &mut request,
        tool_ctx.as_ref(),
        character,
        max_tool_iterations,
        dry_run,
    )
    .await?;

    let paths = LibrarianSweepPaths {
        data_dir,
        memory_dir: &setup.memory_dir,
        memory_index_path: &setup.memory_index_path,
        state_path: &setup.state_path,
    };

    if dry_run {
        return Ok(Some(build_dry_run_dream_result(
            character,
            setup.ran_at,
            &paths,
            loop_result,
        )));
    }

    let result = finalize_librarian_sweep(
        &setup.store,
        character,
        &setup.ran_at,
        setup.state,
        setup.before,
        loop_result,
        &paths,
    )
    .await?;

    // Opt-in: push the workspace memory history after a successful sweep.
    // Best-effort — a failed push never fails the pass.
    if loaded_config.app.memory.git_push {
        crate::tools::workspace::git_push_workspace_best_effort(
            &setup.workspace_dir,
            character,
            "dreaming",
        )
        .await;
    }

    Ok(Some(result))
}

/// Per-sweep context loaded before the librarian runs: resolved paths, the
/// prior dream state, and a pre-pass snapshot of the memory files.
struct LibrarianSweepSetup {
    memory_dir: PathBuf,
    workspace_dir: PathBuf,
    memory_index_path: PathBuf,
    state_path: PathBuf,
    state: DreamState,
    store: MarkdownMemoryStore,
    before: MemorySnapshot,
    ran_at: String,
}

/// Resolve the sweep's paths, load the dream state, and snapshot the memory
/// files. Returns `None` when dreaming is not yet due and the run is neither
/// forced nor a dry run.
async fn prepare_librarian_sweep(
    loaded_config: &LoadedConfig,
    data_dir: &Path,
    character: &str,
    dry_run: bool,
    force: bool,
) -> Result<Option<LibrarianSweepSetup>, DreamingError> {
    let cfg = &loaded_config.app.memory.dreaming;
    let memory_dir = character_memory_dir(&loaded_config.dirs.config, character);
    let workspace_dir = character_workspace_dir(&loaded_config.dirs.config, character);
    let memory_index_path = workspace_dir.join(MEMORY_INDEX_FILE);
    let state_path = dream_state_path(data_dir, character);
    let state = read_state(data_dir, &loaded_config.dirs.config, character).await?;
    if !force && !dry_run && !is_due(cfg, state.last_run_at.as_deref())? {
        return Ok(None);
    }

    let store = MarkdownMemoryStore::open(&memory_dir)
        .await
        .map_err(|e| DreamingError::Memory(e.to_string()))?;
    let before = snapshot_memory_files(&store, &memory_index_path).await?;
    let now = Local::now();
    let ran_at = now.to_rfc3339();

    Ok(Some(LibrarianSweepSetup {
        memory_dir,
        workspace_dir,
        memory_index_path,
        state_path,
        state,
        store,
        before,
        ran_at,
    }))
}

/// Assemble the librarian LLM request, shared tool context, and per-model
/// tool-iteration cap for one sweep.
fn prepare_librarian_call(
    loaded_config: &LoadedConfig,
    data_dir: &Path,
    llm_client: &LedgerClient,
    character: &str,
    cached_request: Option<&LlmRequest>,
    dry_run: bool,
    ran_at: &str,
) -> Result<(LlmRequest, std::sync::Arc<SharedToolContext>, Option<u32>), DreamingError> {
    let mut request =
        build_librarian_request(loaded_config, character, cached_request, dry_run, ran_at)?;
    request.forensic_character = Some(character.to_owned());
    request.rid = None;
    let tool_ctx = std::sync::Arc::new(build_librarian_tool_context(
        loaded_config,
        data_dir,
        llm_client,
        character,
        dry_run,
    ));

    // Per-model tool-iteration cap (the single unified surface). `None` =
    // unlimited (default); the librarian loop then ends only when the model
    // stops requesting tools.
    let max_tool_iterations = crate::preferences::resolve_background_model(
        loaded_config,
        shore_config::app::BackgroundTask::Dreaming,
        character,
    )
    .and_then(|m| m.max_tool_iterations);

    Ok((request, tool_ctx, max_tool_iterations))
}

/// Paths referenced while writing and reporting a librarian sweep.
struct LibrarianSweepPaths<'paths> {
    data_dir: &'paths Path,
    memory_dir: &'paths Path,
    memory_index_path: &'paths Path,
    state_path: &'paths Path,
}

/// Build the dry-run `DreamSweepResult`: reports the would-write paths without
/// touching memory.
fn build_dry_run_dream_result(
    character: &str,
    ran_at: String,
    paths: &LibrarianSweepPaths<'_>,
    loop_result: LibrarianLoopResult,
) -> DreamSweepResult {
    let would_write_paths = vec![
        paths.memory_index_path.display().to_string(),
        crate::memory::dreams_log::dreams_log_path(paths.data_dir, character)
            .display()
            .to_string(),
        paths.state_path.display().to_string(),
    ];
    DreamSweepResult {
        character: character.to_owned(),
        dry_run: true,
        ran_at,
        mode: "ai_librarian".to_owned(),
        phase_summaries: vec![DreamPhaseSummary {
            phase: "librarian".to_owned(),
            summary: format!(
                "dry-run AI librarian pass inspected memory with {} tool round(s); writes were disabled",
                loop_result.tool_rounds
            ),
            candidate_count: 0,
            promoted_count: 0,
            rejected_count: 0,
            paths: Vec::new(),
        }],
        candidate_count: 0,
        indexed_count: 0,
        promoted_count: 0,
        rejected_count: 0,
        candidates: Vec::new(),
        rem_themes: Vec::new(),
        promotions: Vec::new(),
        rejected: Vec::new(),
        indexed: Vec::new(),
        promoted: Vec::new(),
        paths_written: Vec::new(),
        would_write_paths,
        staged_path: None,
        dreams_path: None,
        memory_path: None,
        inspected: loop_result.inspected,
        changed: Vec::new(),
        tools_used: loop_result.tools_used,
        tool_rounds: loop_result.tool_rounds,
        audit_appended: false,
        final_report: loop_result.final_report,
    }
}

/// Summarise a completed (non-dry-run) librarian pass for the result payload.
fn librarian_phase_summary(
    tool_rounds: u32,
    changed_count: usize,
    indexed_count: usize,
    audit_appended: bool,
    paths: Vec<String>,
) -> DreamPhaseSummary {
    DreamPhaseSummary {
        phase: "librarian".to_owned(),
        summary: format!(
            "AI librarian pass used {tool_rounds} tool round(s), changed {changed_count} file(s), and {} DREAMS.md audit fallback",
            if audit_appended {
                "needed a"
            } else {
                "did not need a"
            }
        ),
        candidate_count: 0,
        promoted_count: indexed_count,
        rejected_count: 0,
        paths,
    }
}

/// Apply a completed librarian sweep's writes — fallback MEMORY.md, the
/// daemon-controlled DREAMS.md audit, and the dream state — then snapshot the
/// changes and assemble the final `DreamSweepResult`.
async fn finalize_librarian_sweep(
    store: &MarkdownMemoryStore,
    character: &str,
    ran_at: &str,
    state: DreamState,
    before: MemorySnapshot,
    loop_result: LibrarianLoopResult,
    paths: &LibrarianSweepPaths<'_>,
) -> Result<DreamSweepResult, DreamingError> {
    let memory_created_by_fallback =
        ensure_memory_index_after_librarian(store, paths.memory_index_path, character, ran_at)
            .await?;
    if memory_created_by_fallback {
        if let Err(e) = crate::memory::deferred_edits::note_memory_index_deferred(
            &character_data_dir(paths.data_dir, character),
        ) {
            warn!(
                character,
                error = %e,
                "Dreaming: failed to defer fallback MEMORY.md activation"
            );
        }
    }

    // Always write the daemon-controlled audit entry. DREAMS.md lives in the
    // data directory, outside the workspace, so the model cannot reach it
    // through the write tool — every audit is daemon-generated.
    append_librarian_audit(
        paths.data_dir,
        character,
        ran_at,
        &loop_result.inspected,
        &loop_result.changed,
        memory_created_by_fallback,
        loop_result.final_report.as_deref(),
    )
    .await?;
    let audit_appended = true;

    let mut next_state = state;
    next_state.last_run_at = Some(ran_at.to_owned());
    next_state.runs = next_state.runs.saturating_add(1);
    next_state.last_candidates_path = None;
    next_state.last_signals_path = None;
    next_state.last_promotions_path = None;
    write_state(paths.data_dir, character, &next_state).await?;

    let after = snapshot_memory_files(store, paths.memory_index_path).await?;
    Ok(build_librarian_sweep_result(
        character,
        ran_at,
        &before,
        &after,
        loop_result,
        paths,
        audit_appended,
    ))
}

/// Diff the before/after memory snapshots and assemble the completed sweep's
/// `DreamSweepResult`.
fn build_librarian_sweep_result(
    character: &str,
    ran_at: &str,
    before: &MemorySnapshot,
    after: &MemorySnapshot,
    loop_result: LibrarianLoopResult,
    paths: &LibrarianSweepPaths<'_>,
    audit_appended: bool,
) -> DreamSweepResult {
    let mut changed = changed_paths(before, after);
    if !changed.iter().any(|path| path == DREAM_STATE_REL) {
        changed.push(DREAM_STATE_REL.to_owned());
    }
    let paths_written = changed
        .iter()
        .map(|path| {
            if path == MEMORY_INDEX_FILE {
                paths.memory_index_path.display().to_string()
            } else if path == DREAM_STATE_REL {
                paths.state_path.display().to_string()
            } else {
                paths.memory_dir.join(path).display().to_string()
            }
        })
        .collect::<Vec<_>>();
    let indexed_count = usize::from(after.contains_key(MEMORY_INDEX_FILE));

    DreamSweepResult {
        character: character.to_owned(),
        dry_run: false,
        ran_at: ran_at.to_owned(),
        mode: "ai_librarian".to_owned(),
        phase_summaries: vec![librarian_phase_summary(
            loop_result.tool_rounds,
            changed.len(),
            indexed_count,
            audit_appended,
            paths_written.clone(),
        )],
        candidate_count: 0,
        indexed_count,
        promoted_count: 0,
        rejected_count: 0,
        candidates: Vec::new(),
        rem_themes: Vec::new(),
        promotions: Vec::new(),
        rejected: Vec::new(),
        indexed: if after.contains_key(MEMORY_INDEX_FILE) {
            vec![MEMORY_INDEX_FILE.to_owned()]
        } else {
            Vec::new()
        },
        promoted: Vec::new(),
        paths_written,
        would_write_paths: Vec::new(),
        staged_path: Some(paths.state_path.display().to_string()),
        dreams_path: Some(
            crate::memory::dreams_log::dreams_log_path(paths.data_dir, character)
                .display()
                .to_string(),
        ),
        memory_path: Some(paths.memory_index_path.display().to_string()),
        inspected: loop_result.inspected,
        changed,
        tools_used: loop_result.tools_used,
        tool_rounds: loop_result.tool_rounds,
        audit_appended,
        final_report: loop_result.final_report,
    }
}

/// Legacy deterministic sweep retained only for dry-run diagnostics and
/// fallback-oriented unit coverage. Production scheduled and command-driven
/// dreaming uses [`run_librarian_sweep`].
pub async fn run_legacy_diagnostic_sweep(
    data_dir: &Path,
    config_dir: &Path,
    character: &str,
    cfg: &DreamingConfig,
    dry_run: bool,
    force: bool,
) -> Result<Option<DreamSweepResult>, DreamingError> {
    let memory_dir = character_memory_dir(config_dir, character);
    let workspace_dir = character_workspace_dir(config_dir, character);
    let memory_index_path = workspace_dir.join(MEMORY_INDEX_FILE);
    let dream_dir = dream_data_dir(data_dir, character);
    let state_path = dream_state_path(data_dir, character);
    let state = read_state(data_dir, config_dir, character).await?;
    if !force && !dry_run && !is_due(cfg, state.last_run_at.as_deref())? {
        return Ok(None);
    }

    let store = MarkdownMemoryStore::open(&memory_dir)
        .await
        .map_err(|e| DreamingError::Memory(e.to_string()))?;
    let entries = store
        .list_all()
        .await
        .map_err(|e| DreamingError::Memory(e.to_string()))?;
    let now = Local::now();
    let ran_at = now.to_rfc3339();
    let stamp = now.format("%Y%m%d-%H%M%S").to_string();
    let day = now.format("%Y-%m-%d").to_string();

    let light = run_light_phase(entries, &state, &ran_at);
    let rem = run_rem_phase(&light.candidates);
    let deep = run_deep_phase(&store, light.candidates.clone(), &rem).await?;

    let paths = legacy_artifact_paths(&dream_dir, &stamp, &day, state_path, memory_index_path);
    let would_write_paths = legacy_would_write_paths(&paths, data_dir, character);
    let promoted = deep
        .promoted
        .iter()
        .map(|promotion| promotion.text.clone())
        .collect::<Vec<_>>();

    let run = LegacyDreamRun {
        ran_at,
        state,
        light,
        rem,
        deep,
        promoted,
        would_write_paths,
    };

    if dry_run {
        return Ok(Some(build_legacy_dry_run_result(character, run)));
    }

    Ok(Some(
        persist_and_build_legacy_result(&store, data_dir, character, run, &paths).await?,
    ))
}

/// Filesystem paths for one legacy diagnostic sweep's artifacts.
struct LegacyDreamPaths {
    candidates_path: PathBuf,
    signals_path: PathBuf,
    promotions_path: PathBuf,
    state_path: PathBuf,
    memory_index_path: PathBuf,
    light_report_path: PathBuf,
    rem_report_path: PathBuf,
    deep_report_path: PathBuf,
    candidates_rel: String,
    signals_rel: String,
    promotions_rel: String,
}

/// One legacy diagnostic sweep's computed run state, bundled so the result
/// builders stay within the argument budget.
struct LegacyDreamRun {
    ran_at: String,
    state: DreamState,
    light: LightPhaseOutput,
    rem: RemPhaseOutput,
    deep: DeepPhaseOutput,
    promoted: Vec<String>,
    would_write_paths: Vec<String>,
}

/// Compute the per-run artifact paths (timestamped JSON + day-keyed reports)
/// under the character's dream data directory.
fn legacy_artifact_paths(
    dream_dir: &Path,
    stamp: &str,
    day: &str,
    state_path: PathBuf,
    memory_index_path: PathBuf,
) -> LegacyDreamPaths {
    let candidates_file = format!("candidates-{stamp}.json");
    let signals_file = format!("phase-signals-{stamp}.json");
    let promotions_file = format!("promotions-{stamp}.json");
    LegacyDreamPaths {
        candidates_path: dream_dir.join(&candidates_file),
        signals_path: dream_dir.join(&signals_file),
        promotions_path: dream_dir.join(&promotions_file),
        candidates_rel: dream_data_rel(&candidates_file),
        signals_rel: dream_data_rel(&signals_file),
        promotions_rel: dream_data_rel(&promotions_file),
        light_report_path: dream_dir
            .join(DREAM_REPORTS_DIR)
            .join("light")
            .join(format!("{day}.md")),
        rem_report_path: dream_dir
            .join(DREAM_REPORTS_DIR)
            .join("rem")
            .join(format!("{day}.md")),
        deep_report_path: dream_dir
            .join(DREAM_REPORTS_DIR)
            .join("deep")
            .join(format!("{day}.md")),
        state_path,
        memory_index_path,
    }
}

/// The full set of paths a non-dry-run legacy sweep would write.
fn legacy_would_write_paths(
    paths: &LegacyDreamPaths,
    data_dir: &Path,
    character: &str,
) -> Vec<String> {
    vec![
        paths.candidates_path.display().to_string(),
        paths.signals_path.display().to_string(),
        paths.promotions_path.display().to_string(),
        paths.state_path.display().to_string(),
        crate::memory::dreams_log::dreams_log_path(data_dir, character)
            .display()
            .to_string(),
        paths.memory_index_path.display().to_string(),
        paths.light_report_path.display().to_string(),
        paths.rem_report_path.display().to_string(),
        paths.deep_report_path.display().to_string(),
    ]
}

/// Build the dry-run legacy diagnostic result: report phase findings and the
/// would-write paths without touching disk.
fn build_legacy_dry_run_result(character: &str, run: LegacyDreamRun) -> DreamSweepResult {
    let LegacyDreamRun {
        ran_at,
        light,
        rem,
        deep,
        promoted,
        would_write_paths,
        ..
    } = run;
    let summaries = phase_summaries(&light, &rem, &deep, &[]);
    DreamSweepResult {
        character: character.to_owned(),
        dry_run: true,
        ran_at,
        mode: "legacy_diagnostic".to_owned(),
        phase_summaries: summaries,
        candidate_count: deep.candidates.len(),
        indexed_count: deep.promoted.len(),
        promoted_count: deep.promoted.len(),
        rejected_count: deep.rejected.len(),
        candidates: deep.candidates,
        rem_themes: rem.themes,
        promotions: deep.promoted,
        rejected: deep.rejected,
        indexed: promoted.clone(),
        promoted,
        paths_written: Vec::new(),
        would_write_paths,
        staged_path: None,
        dreams_path: None,
        memory_path: None,
        inspected: Vec::new(),
        changed: Vec::new(),
        tools_used: Vec::new(),
        tool_rounds: 0,
        audit_appended: false,
        final_report: None,
    }
}

/// Persist a legacy diagnostic sweep's artifacts (candidate/signal/promotion
/// JSON, phase reports, dream diary, memory index, and dream state) and
/// assemble the final result.
async fn persist_and_build_legacy_result(
    store: &MarkdownMemoryStore,
    data_dir: &Path,
    character: &str,
    run: LegacyDreamRun,
    paths: &LegacyDreamPaths,
) -> Result<DreamSweepResult, DreamingError> {
    write_legacy_artifacts(store, data_dir, character, &run, paths).await?;

    let LegacyDreamRun {
        ran_at,
        state,
        light,
        rem,
        deep,
        promoted,
        would_write_paths,
    } = run;

    let mut next_state = state;
    next_state.last_run_at = Some(ran_at.clone());
    next_state.runs = next_state.runs.saturating_add(1);
    next_state.last_candidates_path = Some(paths.candidates_rel.clone());
    next_state.last_signals_path = Some(paths.signals_rel.clone());
    next_state.last_promotions_path = Some(paths.promotions_rel.clone());
    update_seen_state(&mut next_state, &deep.candidates);
    write_state(data_dir, character, &next_state).await?;

    let paths_written = would_write_paths;

    Ok(DreamSweepResult {
        character: character.to_owned(),
        dry_run: false,
        ran_at,
        mode: "legacy_diagnostic".to_owned(),
        phase_summaries: phase_summaries(&light, &rem, &deep, &paths_written),
        candidate_count: deep.candidates.len(),
        indexed_count: deep.promoted.len(),
        promoted_count: deep.promoted.len(),
        rejected_count: deep.rejected.len(),
        candidates: deep.candidates,
        rem_themes: rem.themes,
        promotions: deep.promoted,
        rejected: deep.rejected,
        indexed: promoted.clone(),
        promoted,
        paths_written,
        would_write_paths: Vec::new(),
        staged_path: Some(paths.candidates_path.display().to_string()),
        dreams_path: Some(
            crate::memory::dreams_log::dreams_log_path(data_dir, character)
                .display()
                .to_string(),
        ),
        memory_path: Some(paths.memory_index_path.display().to_string()),
        inspected: Vec::new(),
        changed: Vec::new(),
        tools_used: Vec::new(),
        tool_rounds: 0,
        audit_appended: false,
        final_report: None,
    })
}

/// Write the legacy sweep's artifacts: candidate/signal/promotion JSON, the
/// dream diary, the per-phase reports, and the regenerated memory index.
async fn write_legacy_artifacts(
    store: &MarkdownMemoryStore,
    data_dir: &Path,
    character: &str,
    run: &LegacyDreamRun,
    paths: &LegacyDreamPaths,
) -> Result<(), DreamingError> {
    let character_data_dir = character_data_dir(data_dir, character);

    write_data_json(
        &character_data_dir,
        &paths.candidates_path,
        &run.deep.candidates,
    )
    .await?;
    write_data_json(&character_data_dir, &paths.signals_path, &run.rem).await?;
    write_data_json(&character_data_dir, &paths.promotions_path, &run.deep).await?;
    append_dream_diary(
        data_dir,
        character,
        &run.ran_at,
        &run.light,
        &run.rem,
        &run.deep,
    )
    .await?;
    write_phase_reports(
        &character_data_dir,
        &run.ran_at,
        (
            &paths.light_report_path,
            &paths.rem_report_path,
            &paths.deep_report_path,
        ),
        &run.light,
        &run.rem,
        &run.deep,
    )
    .await?;
    write_memory_index(
        store,
        &paths.memory_index_path,
        character,
        &run.ran_at,
        &run.deep.promoted,
    )
    .await
}

#[derive(Debug, Default)]
struct LibrarianLoopResult {
    final_report: Option<String>,
    inspected: Vec<String>,
    changed: Vec<String>,
    tools_used: Vec<String>,
    tool_rounds: u32,
}

type MemorySnapshot = BTreeMap<String, String>;

/// Derive the librarian's base request from the cached chat request.
///
/// The cached request supplies the conversation prefix, but the *model*
/// still follows the background resolution chain: an explicit
/// `defaults.background.dreaming` (or blanket `background.model`) pin wins
/// over cache reuse. Riding the chat model's warm prompt cache is an
/// optimization for the no-pin default — where the chain resolves to the
/// chat model anyway and the wholesale clone reuses the request as-is —
/// not a license to run dreaming on a model the user pinned it away from.
fn librarian_base_from_cached(
    loaded_config: &LoadedConfig,
    character: &str,
    cached: &LlmRequest,
) -> Result<LlmRequest, DreamingError> {
    let resolved = crate::preferences::resolve_background_model(
        loaded_config,
        shore_config::app::BackgroundTask::Dreaming,
        character,
    )
    .ok_or_else(|| DreamingError::Config("no chat model configured for dreaming".into()))?;
    if resolved.model_id == cached.model {
        return Ok(cached.clone());
    }
    info!(
        character,
        dreaming_model = %resolved.name,
        cached_model = %cached.model,
        "Dreaming: background model pin overrides cached chat request model"
    );
    // Same content as the wholesale clone — messages, system, and tool
    // definitions are kept byte-identical so the pinned model's own
    // provider-side cache stays stable across daily passes — but the
    // request envelope (SDK, credentials, sampler settings) is rebuilt
    // for the pinned model.
    LedgerClient::build_request_with_provider_keys(
        &resolved,
        &loaded_config.providers,
        cached.messages.clone(),
        cached.system.clone(),
        cached.tools.clone(),
        None,
    )
    .map_err(|e| DreamingError::Llm(e.to_string()))
}

fn build_librarian_request(
    loaded_config: &LoadedConfig,
    character: &str,
    cached_request: Option<&LlmRequest>,
    dry_run: bool,
    ran_at: &str,
) -> Result<LlmRequest, DreamingError> {
    let display_name = loaded_config.app.defaults.resolve_display_name();
    let character_data_dir = character_data_dir(&loaded_config.dirs.data, character);
    if let Err(e) = crate::memory::deferred_edits::ensure_active_prompt_snapshot(
        &character_data_dir,
        &loaded_config.dirs.config,
        character,
    ) {
        warn!(
            character,
            error = %e,
            "Dreaming: failed to prepare active prompt snapshot"
        );
    }

    let character_definition =
        crate::memory::deferred_edits::load_active_prompt_file(&character_data_dir, SOUL_FILE);
    let user_definition =
        crate::memory::deferred_edits::load_active_prompt_file(&character_data_dir, USER_FILE);
    let system = build_librarian_prompt(
        character,
        &display_name,
        character_definition.as_deref(),
        user_definition.as_deref(),
        dry_run,
        ran_at,
    );
    let user_prompt = if dry_run {
        "Run the dry-run memory librarian pass now. Inspect memory files with read-only tools and finish with a proposed plan. Do not write, edit, or emit a user-facing message."
    } else {
        "Run the memory librarian pass now. Use memory tools to inspect and improve workspace/memory, update MEMORY.md (at the workspace root), and finish with a concise summary of what you inspected and changed. The daemon writes the dreams audit log automatically; do not try to write DREAMS.md yourself. Do not emit a user-facing message."
    };
    if let Some(cached) = cached_request {
        let mut request = librarian_base_from_cached(loaded_config, character, cached)?;
        request.rid = None;
        // Append the librarian's user turn and pin the librarian system
        // instruction at a fixed slot via `push_inline_system`. The
        // librarian tool loop in `run_librarian_loop` pushes
        // `assistant` + `user(tool_result)` after this, so the system
        // entry's index must not depend on tail length. (The removed
        // `system_suffix` affordance re-expanded the suffix at the
        // current tail on every `generate()` call, drifting the system
        // slot and busting Anthropic's content-addressed prefix cache
        // across iterations — see [`LlmRequest::push_inline_system`].)
        //
        // The cached chat prefix is left untouched — neither the user
        // turn nor the system entry mutates earlier messages, so
        // subsequent chat calls reusing this request's prefix still hit
        // their cache as before.
        request
            .messages
            .push(json!({"role": "user", "content": user_prompt}));
        request.push_inline_system(system);
        // Dreaming runs at most a few times per day; route the payload
        // log to the long-retention tier so weeks-old memory-evolution
        // forensics aren't pruned with chat-volume traffic.
        request.retain_long = true;
        return Ok(request);
    }

    let resolved = crate::preferences::resolve_background_model(
        loaded_config,
        shore_config::app::BackgroundTask::Dreaming,
        character,
    )
    .ok_or_else(|| DreamingError::Config("no chat model configured for dreaming".into()))?;
    let tools = build_librarian_tool_defs(character, &display_name, dry_run);
    // Fresh path: no chat cache to inherit. Branch on whether this SDK
    // routes through Anthropic's prompt cache:
    //
    // - Anthropic: push the dreaming prompt as an inline `role:"system"`
    //   entry right after the user turn. The sidecar Anthropic adapter merges
    //   it into the preceding user, giving the model an embedded
    //   `<system_instruction>` block. The slot is fixed before the tool loop,
    //   so the merge target stays byte-stable across iterations (same
    //   invariant as the cached path).
    //
    // - OpenAI / Gemini / Z.AI: keep the dreaming prompt at the
    //   top-level `request.system`. These providers don't merge inline
    //   system messages into the preceding user, so emitting it
    //   top-level matches their idiomatic system-prompt shape and
    //   avoids materially shifting the model-facing wire layout for
    //   SDKs that don't have the cache-prefix concern motivating this
    //   change.
    let uses_anthropic_cache = resolved.sdk.uses_anthropic_prompt_cache();
    let system_arg = if uses_anthropic_cache {
        None
    } else {
        Some(json!(&system))
    };
    let mut request = LedgerClient::build_request_with_provider_keys(
        &resolved,
        &loaded_config.providers,
        vec![json!({"role": "user", "content": user_prompt})],
        system_arg,
        Some(tools),
        None,
    )
    .map_err(|e| DreamingError::Llm(e.to_string()))?;
    if uses_anthropic_cache {
        request.push_inline_system(system);
    }
    request.retain_long = true;
    Ok(request)
}

fn build_librarian_prompt(
    character: &str,
    display_name: &str,
    character_definition: Option<&str>,
    user_definition: Option<&str>,
    dry_run: bool,
    _ran_at: &str,
) -> String {
    const TEMPLATE: &str = crate::include_prompt!("../../prompts/memory/dreaming/librarian.md");
    let mut prompt = format!(
        "{}\n",
        TEMPLATE
            .replace("{{character}}", character)
            .replace("{{display_name}}", display_name)
    );

    if dry_run {
        prompt.push_str(
            "\nThis is a dry run. Write and edit tools are unavailable. Inspect files and produce a concise internal plan of what would change.\n",
        );
    }

    if let Some(definition) = character_definition.filter(|s| !s.trim().is_empty()) {
        prompt.push_str("\n<character_identity>\n");
        prompt.push_str(definition);
        prompt.push_str("\n</character_identity>\n");
    }
    if let Some(definition) = user_definition.filter(|s| !s.trim().is_empty()) {
        prompt.push_str("\n<user_profile>\n");
        prompt.push_str(definition);
        prompt.push_str("\n</user_profile>\n");
    }
    prompt
}

fn build_librarian_tool_defs(character: &str, display_name: &str, dry_run: bool) -> Vec<Value> {
    // The librarian uses its own fixed tool set, independent of the character's
    // `[tools]` allowlist. Express it directly as an allowlist so
    // `render_tool_defs` yields exactly these (in registry order).
    let mut names: Vec<String> = ["read", "search", "search_chat_logs"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    if !dry_run {
        names.push("edit".to_owned());
        names.push("git".to_owned());
    }
    let tools_cfg = shore_config::app::ToolsConfig {
        enabled_tools: names,
        ..Default::default()
    };
    tool_system::render_tool_defs(&tools_cfg, character, display_name)
}

fn build_librarian_tool_context(
    loaded_config: &LoadedConfig,
    data_dir: &Path,
    llm_client: &LedgerClient,
    character: &str,
    _dry_run: bool,
) -> SharedToolContext {
    let character_data_dir = character_data_dir(data_dir, character);
    let image_gen_config = crate::memory::compaction_impls::resolve_image_gen_config(
        loaded_config.app.defaults.image_generation.as_deref(),
        &loaded_config.models.image_generation,
        &loaded_config.providers,
    )
    .ok();
    let embedder = crate::memory::retrieval::resolve_embedder(
        loaded_config.app.defaults.embedding.as_deref(),
        &loaded_config.models.embedding,
        &loaded_config.providers,
        llm_client.inner().http_client(),
    )
    .ok();

    SharedToolContext {
        image_dir: character_data_dir
            .join("images")
            .to_string_lossy()
            .into_owned(),
        llm_client: llm_client.inner().clone(),
        image_gen_config,
        search_config: loaded_config.app.tools.web_search.clone(),
        character_name: character.to_owned(),
        workspace_dir: character_workspace_dir(&loaded_config.dirs.config, character)
            .to_string_lossy()
            .into_owned(),
        markdown_store: MarkdownMemoryStore::open_sync(character_memory_dir(
            &loaded_config.dirs.config,
            character,
        ))
        .ok(),
        memory_retrieval_config: loaded_config.app.memory.retrieval.clone(),
        embedder,
        memory_index_path: crate::memory::workspace_index::index_path(
            &loaded_config.dirs.cache,
            character,
        ),
        config_dir: loaded_config.dirs.config.to_string_lossy().into_owned(),
        character_data_dir: character_data_dir.to_string_lossy().into_owned(),
        // Wire the sub-agent runtime so `ask_*` works during dreaming ticks.
        // Background context: no live client channel, so the nested loop's
        // frames drain rather than stream (see `SubagentRuntime::background`).
        // Gated on configured sub-agents to skip the config clone otherwise.
        subagent_runtime: if loaded_config.app.subagents.is_empty() {
            None
        } else {
            Some(std::sync::Arc::new(
                crate::tools::subagent::SubagentRuntime::background(
                    llm_client.clone(),
                    std::sync::Arc::new(loaded_config.clone()),
                ),
            ))
        },
        // Background ticks don't wire MCP yet (no live registry handle here).
        mcp_registry: None,
    }
}

async fn run_librarian_loop(
    client: &LedgerClient,
    loaded_config: &LoadedConfig,
    request: &mut LlmRequest,
    tool_ctx: &dyn ToolContext,
    character: &str,
    max_tool_iterations: Option<u32>,
    dry_run: bool,
) -> Result<LibrarianLoopResult, DreamingError> {
    let mut loop_result = LibrarianLoopResult::default();

    let mut iteration: u32 = 0;
    loop {
        // `None` = unlimited; the only exit below is the model ending cleanly.
        if let Some(max) = max_tool_iterations {
            if iteration >= max {
                break;
            }
        }
        let (resp, _fallback_events) = client
            .generate_with_config_fallback(
                request,
                loaded_config,
                CallType::Dreaming,
                character,
                false,
            )
            .await
            .map_err(|e| DreamingError::Llm(e.to_string()))?;
        remember_final_report(&mut loop_result, &resp);
        push_assistant_response(request, &resp);

        // Provider may have changed under config fallback; read it back from the
        // request the call actually ran on.
        let provider = request.provider_key.clone();
        let tool_uses = crate::content_util::extract_tool_uses(&resp.content_blocks);
        if tool_uses.is_empty() || resp.finish_reason != "tool_use" {
            record_dreaming_transcript(
                client,
                character,
                dry_run,
                iteration,
                provider.as_deref(),
                &resp,
                &[],
            );
            return Ok(loop_result);
        }

        loop_result.tool_rounds = loop_result.tool_rounds.saturating_add(1);
        let (tool_results, captured) = dispatch_librarian_tools(
            tool_ctx,
            character,
            iteration,
            dry_run,
            tool_uses,
            &mut loop_result,
        )
        .await;
        record_dreaming_transcript(
            client,
            character,
            dry_run,
            iteration,
            provider.as_deref(),
            &resp,
            &captured,
        );
        request
            .messages
            .push(json!({"role": "user", "content": tool_results}));

        iteration = iteration.saturating_add(1);
    }

    warn!(
        character,
        max = ?max_tool_iterations,
        "Dreaming: librarian tool loop hit configured cap"
    );
    Ok(loop_result)
}

/// Dispatch every tool call from one librarian iteration: build the
/// `tool_result` blocks for the next request turn and capture each tool's full
/// output for the transcript, while recording inspected/changed paths and tool
/// intents on `loop_result`.
async fn dispatch_librarian_tools(
    tool_ctx: &dyn ToolContext,
    character: &str,
    iteration: u32,
    dry_run: bool,
    tool_uses: Vec<(String, String, Value)>,
    loop_result: &mut LibrarianLoopResult,
) -> (Vec<Value>, Vec<crate::transcript_capture::CapturedTool>) {
    let mut tool_results = Vec::new();
    let mut captured: Vec<crate::transcript_capture::CapturedTool> = Vec::new();
    for (id, name, input) in tool_uses {
        loop_result.tools_used.push(name.clone());
        record_librarian_tool_intent(loop_result, &name, &input);
        debug!(
            character,
            iteration,
            tool = %name,
            input = %input,
            "Dreaming: executing librarian tool"
        );

        let (output, is_error) =
            if let Some(blocked) = blocked_librarian_tool_result(&name, dry_run) {
                blocked
            } else {
                crate::content_util::dispatch_result_to_output(
                    tool_system::dispatch_tool(&name, input.clone(), tool_ctx).await,
                )
            };

        if !is_error && name == "edit" {
            if let Some(path) = tool_path(&input) {
                loop_result.changed.push(path.to_owned());
            }
        }

        captured.push(crate::transcript_capture::CapturedTool {
            name: name.clone(),
            input: input.clone(),
            output: output.clone(),
            is_error,
        });
        tool_results.push(crate::content_util::build_tool_result_json(
            &id, &output, is_error,
        ));
    }
    (tool_results, captured)
}

/// Record one dreaming-pass transcript entry to the store (skipped on dry runs,
/// which preview without writing artifacts; a no-op when capture is disabled).
fn record_dreaming_transcript(
    client: &LedgerClient,
    character: &str,
    dry_run: bool,
    iteration: u32,
    provider: Option<&str>,
    resp: &GenerateResponse,
    tools: &[crate::transcript_capture::CapturedTool],
) {
    if dry_run {
        return;
    }
    if let Some(store) = client.inner().call_store() {
        crate::transcript_capture::record(
            store,
            "dreaming",
            character,
            CallType::Dreaming.as_str(),
            iteration,
            provider,
            resp,
            tools,
        );
    }
}

fn remember_final_report(loop_result: &mut LibrarianLoopResult, resp: &GenerateResponse) {
    let text = resp.extract_text();
    if !text.trim().is_empty() {
        loop_result.final_report = Some(text.trim().to_owned());
    }
}

fn push_assistant_response(request: &mut LlmRequest, resp: &GenerateResponse) {
    let assistant_content: Vec<Value> = resp
        .content_blocks
        .iter()
        .filter_map(|block| {
            crate::content_util::content_block_to_request_json_for_sdk(block, &request.sdk)
        })
        .collect();

    if !assistant_content.is_empty() {
        request
            .messages
            .push(json!({"role": "assistant", "content": assistant_content}));
    } else if !resp.content.trim().is_empty() {
        request
            .messages
            .push(json!({"role": "assistant", "content": resp.content}));
    } else {
        // Empty assistant turn: nothing to append.
    }
}

fn blocked_librarian_tool_result(name: &str, dry_run: bool) -> Option<(String, bool)> {
    // `git` is allowed through so the librarian can commit its memory changes.
    // The dreaming pass curates files, it does not run programs — and with the
    // git tool being the only one that spawns a process, that's now a property
    // of the tool surface rather than something this gate has to enforce.
    if name == "git" && dry_run {
        return Some(("dry-run dreaming does not run commands".to_owned(), true));
    }
    if dry_run && name == "edit" {
        return Some((
            "dry-run dreaming does not write or edit files".to_owned(),
            true,
        ));
    }
    None
}

fn record_librarian_tool_intent(result: &mut LibrarianLoopResult, name: &str, input: &Value) {
    match name {
        "read" => {
            if let Some(path) = tool_path(input) {
                push_unique(&mut result.inspected, path.to_owned());
            }
        }
        "search" | "search_chat_logs" => {
            let query = input
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("<missing query>");
            let scope = tool_path(input).unwrap_or("memory");
            push_unique(&mut result.inspected, format!("{name}:{scope}:{query}"));
        }
        _ => {}
    }
}

fn tool_path(input: &Value) -> Option<&str> {
    input.get("path").and_then(|v| v.as_str())
}

fn push_unique(items: &mut Vec<String>, value: String) {
    if !items.iter().any(|existing| existing == &value) {
        items.push(value);
    }
}

async fn snapshot_memory_files(
    store: &MarkdownMemoryStore,
    memory_index_path: &Path,
) -> Result<MemorySnapshot, DreamingError> {
    let mut snapshot = BTreeMap::new();
    for entry in store
        .list_all()
        .await
        .map_err(|e| DreamingError::Memory(e.to_string()))?
    {
        let _ignored = snapshot.insert(entry.path, entry.content);
    }
    match fs::read_to_string(memory_index_path).await {
        Ok(content) => {
            let _ignored = snapshot.insert(MEMORY_INDEX_FILE.to_owned(), content);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(DreamingError::Io(e.to_string())),
    }
    Ok(snapshot)
}

fn changed_paths(before: &MemorySnapshot, after: &MemorySnapshot) -> Vec<String> {
    let mut keys = before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    keys.retain(|path| before.get(path) != after.get(path));
    keys.into_iter().collect()
}

async fn ensure_memory_index_after_librarian(
    store: &MarkdownMemoryStore,
    memory_index_path: &Path,
    character: &str,
    ran_at: &str,
) -> Result<bool, DreamingError> {
    match fs::read_to_string(memory_index_path).await {
        Ok(content) if !content.trim().is_empty() => Ok(false),
        Ok(_) => {
            write_fallback_memory_index(store, memory_index_path, character, ran_at).await?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            write_fallback_memory_index(store, memory_index_path, character, ran_at).await?;
            Ok(true)
        }
        Err(e) => Err(DreamingError::Io(e.to_string())),
    }
}

async fn write_fallback_memory_index(
    store: &MarkdownMemoryStore,
    memory_index_path: &Path,
    character: &str,
    ran_at: &str,
) -> Result<(), DreamingError> {
    let entries = store
        .list_all()
        .await
        .map_err(|e| DreamingError::Memory(e.to_string()))?;
    let mut body = String::new();
    body.push_str("# Memory Index\n\n");
    body.push_str(
        "This file is the character's map of long-term memory. It is not the full memory itself.\n",
    );
    body.push_str("Use it to decide which memory files to inspect before answering.\n\n");
    body.push_str("Core user facts and standing behavior guidance are already loaded from USER.md and AGENTS.md; do not duplicate them here unless needed as pointers to memory files.\n\n");
    let _ignored = writeln!(body, "Character: {character}");
    _ = writeln!(body, "Last updated: {ran_at}");
    body.push_str("Fallback note: Rust created this minimal index because the AI librarian pass did not leave a usable MEMORY.md.\n\n");
    body.push_str("## Memory areas\n\n");
    if entries.is_empty() {
        body.push_str("- No ordinary memory files were found yet.\n");
    } else {
        for entry in entries.iter().take(MAX_INDEX_FILES) {
            _ = writeln!(body, "- `{}` - {}", entry.path, memory_file_summary(entry));
        }
    }
    body.push_str("\n## Recently updated files\n\n");
    body.push_str("- Needs review during the next AI librarian pass.\n");
    body.push_str("\n## Current conversational throughlines\n\n");
    body.push_str("- Needs review during the next AI librarian pass.\n");
    body.push_str("\n## Needs review\n\n");
    body.push_str("- Previous dreaming pass did not update MEMORY.md directly.\n");
    if let Some(parent) = memory_index_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| DreamingError::Io(e.to_string()))?;
    }
    fs::write(memory_index_path, body)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))
}

async fn append_librarian_audit(
    data_dir: &Path,
    character: &str,
    ran_at: &str,
    inspected: &[String],
    changed: &[String],
    memory_created_by_fallback: bool,
    final_report: Option<&str>,
) -> Result<(), DreamingError> {
    let mut body = String::new();
    let _ignored = write!(body, "AI librarian dreaming pass at `{ran_at}`.\n\n");
    body.push_str("Files inspected:\n");
    push_markdown_list_or_none(&mut body, inspected);
    body.push_str("\nFiles changed by tools:\n");
    push_markdown_list_or_none(&mut body, changed);
    body.push_str("\nMEMORY.md updated:\n");
    body.push_str(if memory_created_by_fallback {
        "- Yes, by Rust fallback (the model left it missing or empty).\n"
    } else {
        "- Present after the pass.\n"
    });
    if let Some(report) = final_report.filter(|report| !report.trim().is_empty()) {
        body.push_str("\nFinal internal report:\n");
        body.push_str(report.trim());
        body.push('\n');
    }

    crate::memory::dreams_log::append_dream_entry(
        data_dir,
        character,
        Local::now().fixed_offset(),
        "AI librarian dreaming pass",
        &body,
    )
    .await
    .map_err(|e| DreamingError::Io(e.to_string()))
}

fn push_markdown_list_or_none(body: &mut String, items: &[String]) {
    if items.is_empty() {
        body.push_str("- None recorded.\n");
        return;
    }
    for item in items {
        let _ignored = writeln!(body, "- `{}`", item.replace('`', "'"));
    }
}

pub fn is_due(cfg: &DreamingConfig, last_run_at: Option<&str>) -> Result<bool, DreamingError> {
    let now = Local::now();
    is_due_at(cfg, last_run_at, now)
}

fn is_due_at(
    cfg: &DreamingConfig,
    last_run_at: Option<&str>,
    now: DateTime<Local>,
) -> Result<bool, DreamingError> {
    let schedule = CronSchedule::parse(&cfg.frequency)
        .map_err(|e| DreamingError::Schedule(format!("{}: {e}", cfg.frequency)))?;
    let max_lateness = Duration::from_std(cfg.max_lateness.as_duration())
        .map_err(|e| DreamingError::Schedule(format!("max_lateness out of range: {e}")))?;
    let window_start = schedule.initial_due_window_start(now);
    let mut after = match last_run_at {
        Some(last) => DateTime::parse_from_rfc3339(last)
            .map_err(|e| DreamingError::Schedule(format!("invalid last_run_at {last:?}: {e}")))?
            .with_timezone(&Local),
        None => window_start
            .checked_sub_signed(Duration::minutes(1))
            .unwrap_or(window_start),
    };
    // Clamp the search start to the lateness window so a far-in-the-past
    // last_run_at (with a frequent cron) doesn't trigger a long occurrence
    // walk. Anything older than `now - max_lateness` is out-of-window anyway;
    // the one-tick margin keeps the boundary occurrence reachable.
    let min_search_after = now
        .checked_sub_signed(max_lateness)
        .and_then(|t| t.checked_sub_signed(Duration::minutes(1)))
        .unwrap_or(now);
    if after < min_search_after {
        after = min_search_after;
    }
    loop {
        let Some(next_due) = schedule.next_after(after) else {
            return Err(DreamingError::Schedule(format!(
                "{}: no matching time found",
                cfg.frequency
            )));
        };
        if next_due > now {
            return Ok(false);
        }
        if now.signed_duration_since(next_due) <= max_lateness {
            return Ok(true);
        }
        // Occurrence is in the past but older than max_lateness — skip it and
        // continue searching for a more recent occurrence still in-window.
        after = next_due;
    }
}

fn dream_data_dir(data_dir: &Path, character: &str) -> PathBuf {
    character_data_dir(data_dir, character).join(DREAM_DATA_DIR)
}

fn dream_state_path(data_dir: &Path, character: &str) -> PathBuf {
    dream_data_dir(data_dir, character).join(DREAM_STATE_FILE)
}

fn dream_data_rel(file_name: &str) -> String {
    format!("{DREAM_DATA_DIR}/{file_name}")
}

async fn read_state(
    data_dir: &Path,
    config_dir: &Path,
    character: &str,
) -> Result<DreamState, DreamingError> {
    let character_data_dir = character_data_dir(data_dir, character);
    let state_path = dream_state_path(data_dir, character);
    if let Some(content) = read_data_text(&character_data_dir, &state_path).await? {
        return serde_json::from_str(&content).map_err(|e| DreamingError::Io(e.to_string()));
    }

    read_legacy_state(&character_memory_dir(config_dir, character)).await
}

async fn read_legacy_state(memory_dir: &Path) -> Result<DreamState, DreamingError> {
    let store = MarkdownMemoryStore::open(memory_dir)
        .await
        .map_err(|e| DreamingError::Memory(e.to_string()))?;
    match store.read(LEGACY_DREAM_STATE_REL).await {
        Ok(entry) => {
            serde_json::from_str(&entry.content).map_err(|e| DreamingError::Io(e.to_string()))
        }
        Err(MarkdownStoreError::NotFound(_)) => Ok(DreamState::default()),
        Err(e) => Err(DreamingError::Memory(e.to_string())),
    }
}

async fn read_data_text(
    character_data_dir: &Path,
    path: &Path,
) -> Result<Option<String>, DreamingError> {
    if !path.starts_with(character_data_dir) {
        return Err(DreamingError::Io(format!(
            "dreaming data path escapes character data dir: {}",
            path.display()
        )));
    }

    let base = match fs::canonicalize(character_data_dir).await {
        Ok(base) => base,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(DreamingError::Io(e.to_string())),
    };
    let canonical = match fs::canonicalize(path).await {
        Ok(canonical) => canonical,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(DreamingError::Io(e.to_string())),
    };
    if !canonical.starts_with(&base) {
        return Err(DreamingError::Io(format!(
            "dreaming data path escapes character data dir: {}",
            path.display()
        )));
    }
    fs::read_to_string(path)
        .await
        .map(Some)
        .map_err(|e| DreamingError::Io(e.to_string()))
}

async fn write_state(
    data_dir: &Path,
    character: &str,
    state: &DreamState,
) -> Result<(), DreamingError> {
    let character_data_dir = character_data_dir(data_dir, character);
    write_data_json(
        &character_data_dir,
        &dream_state_path(data_dir, character),
        state,
    )
    .await
}

async fn ensure_data_write_path(
    character_data_dir: &Path,
    path: &Path,
) -> Result<(), DreamingError> {
    if !path.starts_with(character_data_dir) {
        return Err(DreamingError::Io(format!(
            "dreaming data path escapes character data dir: {}",
            path.display()
        )));
    }

    fs::create_dir_all(character_data_dir)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| DreamingError::Io(e.to_string()))?;
    }

    let base = fs::canonicalize(character_data_dir)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))?;
    let parent = path.parent().unwrap_or(character_data_dir);
    let canonical_parent = fs::canonicalize(parent)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))?;
    if !canonical_parent.starts_with(&base) {
        return Err(DreamingError::Io(format!(
            "dreaming data path escapes character data dir: {}",
            path.display()
        )));
    }

    match fs::canonicalize(path).await {
        Ok(canonical) if !canonical.starts_with(&base) => Err(DreamingError::Io(format!(
            "dreaming data path escapes character data dir: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(DreamingError::Io(e.to_string())),
    }
}

fn run_light_phase(
    entries: Vec<MarkdownEntry>,
    state: &DreamState,
    ran_at: &str,
) -> LightPhaseOutput {
    let mut by_key: BTreeMap<String, DreamCandidate> = BTreeMap::new();
    let mut sources_reviewed: usize = 0;
    let mut duplicates_ignored: usize = 0;
    let mut generated_sources_ignored: usize = 0;

    for entry in entries {
        if is_generated_dreaming_path(&entry.path) {
            generated_sources_ignored = generated_sources_ignored.saturating_add(1);
            continue;
        }
        if !is_candidate_source_path(&entry.path) {
            continue;
        }
        sources_reviewed = sources_reviewed.saturating_add(1);
        for (idx, line) in entry.content.lines().enumerate() {
            let Some(text) = candidate_text_from_line(line) else {
                continue;
            };
            let key = normalize_candidate_text(&text);
            if key.is_empty() {
                continue;
            }
            let evidence = DreamEvidence {
                source: entry.path.clone(),
                line: Some(idx.saturating_add(1)),
                source_kind: source_kind(&entry.path).to_owned(),
                snippet: text.clone(),
            };
            if let Some(existing) = by_key.get_mut(&key) {
                if !existing.evidence.iter().any(|seen| seen == &evidence) {
                    existing.evidence.push(evidence);
                    existing.recall_count = existing.recall_count.saturating_add(1);
                    existing.unique_source_count = unique_source_count(&existing.evidence);
                }
                duplicates_ignored = duplicates_ignored.saturating_add(1);
                continue;
            }

            let candidate =
                stage_new_candidate(state, &key, &text, evidence, &entry.modified_at, ran_at);
            _ = by_key.insert(key, candidate);
        }
    }

    let mut candidates = by_key.into_values().collect::<Vec<_>>();
    candidates.sort_by(|a, b| {
        b.durability_score
            .partial_cmp(&a.durability_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.line.cmp(&b.line))
    });
    candidates.truncate(MAX_CANDIDATES);

    LightPhaseOutput {
        sources_reviewed,
        candidates_staged: candidates.len(),
        duplicates_ignored,
        generated_sources_ignored,
        candidates,
    }
}

/// Build a fresh `DreamCandidate` for a line the sweep has not staged yet,
/// seeding recall counts and first-seen time from prior dream state. The
/// candidate's source, line, and kind come from `evidence`, which becomes its
/// first evidence entry.
fn stage_new_candidate(
    state: &DreamState,
    key: &str,
    text: &str,
    evidence: DreamEvidence,
    modified_at: &str,
    ran_at: &str,
) -> DreamCandidate {
    let prior = state.seen_candidates.get(key);
    let mut recall_count = prior.map_or(1, |seen| seen.recall_count.saturating_add(1));
    if recall_count == 0 {
        recall_count = 1;
    }
    let mut evidence_sources = prior
        .map(|seen| seen.sources.iter().cloned().collect::<BTreeSet<_>>())
        .unwrap_or_default();
    let _ignored = evidence_sources.insert(evidence.source.clone());
    let first_seen_at = match prior {
        Some(seen) if !seen.first_seen_at.is_empty() => seen.first_seen_at.clone(),
        Some(_) | None => ran_at.to_owned(),
    };
    let themes = detect_themes(text);
    let recency = recency_score(modified_at);
    let durability = durability_score(text, &themes);
    let specificity = specificity_score(text);
    DreamCandidate {
        id: candidate_id(key),
        text: text.to_owned(),
        source: evidence.source.clone(),
        line: evidence.line,
        source_kind: evidence.source_kind.clone(),
        first_seen_at,
        last_seen_at: ran_at.to_owned(),
        recall_count,
        unique_source_count: evidence_sources.len(),
        unique_query_count: 0,
        theme_hits: themes,
        recency_score: recency,
        durability_score: durability,
        specificity_score: specificity,
        promotion_score: 0.0,
        score: 0.0,
        gates: Vec::new(),
        promote: false,
        decision_reason: "staged by Light Sleep; Deep has not evaluated it yet".to_owned(),
        evidence: vec![evidence],
    }
}

fn run_rem_phase(candidates: &[DreamCandidate]) -> RemPhaseOutput {
    let mut theme_candidates: BTreeMap<String, Vec<&DreamCandidate>> = BTreeMap::new();
    for candidate in candidates {
        for theme in &candidate.theme_hits {
            theme_candidates
                .entry(theme.clone())
                .or_default()
                .push(candidate);
        }
    }

    let mut themes = theme_candidates
        .iter()
        .map(|(theme, hits)| DreamTheme {
            theme: theme.clone(),
            hits: hits.len(),
            candidate_ids: hits.iter().map(|candidate| candidate.id.clone()).collect(),
            example: hits
                .first()
                .map(|candidate| candidate.text.clone())
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    themes.sort_by(|a, b| b.hits.cmp(&a.hits).then_with(|| a.theme.cmp(&b.theme)));

    let reinforcement_signals = themes
        .iter()
        .filter(|theme| theme.hits > 1)
        .map(|theme| (theme.theme.clone(), theme.hits))
        .collect::<BTreeMap<_, _>>();

    RemPhaseOutput {
        themes,
        reinforcement_signals,
    }
}

async fn run_deep_phase(
    store: &MarkdownMemoryStore,
    candidates: Vec<DreamCandidate>,
    rem: &RemPhaseOutput,
) -> Result<DeepPhaseOutput, DreamingError> {
    let mut evaluated = Vec::with_capacity(candidates.len());
    let mut promoted = Vec::new();
    let mut rejected = Vec::new();

    for mut candidate in candidates {
        let source_still_present = source_still_contains(store, &candidate).await?;
        candidate.promotion_score = score_candidate(&candidate, rem);
        candidate.score = candidate.promotion_score;
        candidate.gates = promotion_gates(&candidate, source_still_present);
        candidate.promote = candidate.gates.iter().all(|gate| gate.passed);
        if candidate.promote {
            "qualified for memory-index throughline".clone_into(&mut candidate.decision_reason);
            promoted.push(DreamPromotion {
                text: candidate.text.clone(),
                score: candidate.promotion_score,
                evidence: candidate.evidence.clone(),
                gates_passed: candidate
                    .gates
                    .iter()
                    .filter(|gate| gate.passed)
                    .map(|gate| gate.name.clone())
                    .collect(),
            });
        } else {
            let failed_gates = candidate
                .gates
                .iter()
                .filter(|gate| !gate.passed)
                .map(|gate| gate.name.clone())
                .collect::<Vec<_>>();
            let reason = candidate
                .gates
                .iter()
                .find(|gate| !gate.passed)
                .map_or_else(
                    || "deferred for more evidence".to_owned(),
                    |gate| gate.reason.clone(),
                );
            candidate.decision_reason.clone_from(&reason);
            rejected.push(DreamRejection {
                text: candidate.text.clone(),
                score: candidate.promotion_score,
                reason,
                failed_gates,
                evidence: candidate.evidence.clone(),
            });
        }
        evaluated.push(candidate);
    }

    Ok(DeepPhaseOutput {
        candidates: evaluated,
        promoted,
        rejected,
    })
}

fn phase_summaries(
    light: &LightPhaseOutput,
    rem: &RemPhaseOutput,
    deep: &DeepPhaseOutput,
    paths: &[String],
) -> Vec<DreamPhaseSummary> {
    vec![
        DreamPhaseSummary {
            phase: "light".to_owned(),
            summary: format!(
                "reviewed {} sources, staged {} candidates, ignored {} duplicate signals; no durable memory was written",
                light.sources_reviewed, light.candidates_staged, light.duplicates_ignored
            ),
            candidate_count: light.candidates_staged,
            promoted_count: 0,
            rejected_count: 0,
            paths: paths
                .iter()
                .filter(|path| {
                    path.contains("candidates-")
                        || path.contains(&format!("{DREAM_DATA_DIR}/{DREAM_REPORTS_DIR}/light/"))
                })
                .cloned()
                .collect(),
        },
        DreamPhaseSummary {
            phase: "rem".to_owned(),
            summary: format!(
                "noticed {} themes and {} reinforcement signals; no durable memory was written",
                rem.themes.len(),
                rem.reinforcement_signals.len()
            ),
            candidate_count: light.candidates_staged,
            promoted_count: 0,
            rejected_count: 0,
            paths: paths
                .iter()
                .filter(|path| {
                    path.contains("phase-signals-")
                        || path.contains(&format!("{DREAM_DATA_DIR}/{DREAM_REPORTS_DIR}/rem/"))
                })
                .cloned()
                .collect(),
        },
        DreamPhaseSummary {
            phase: "deep".to_owned(),
            summary: format!(
                "indexed {} throughlines and deferred {} candidates after scoring gates",
                deep.promoted.len(),
                deep.rejected.len()
            ),
            candidate_count: deep.candidates.len(),
            promoted_count: deep.promoted.len(),
            rejected_count: deep.rejected.len(),
            paths: paths
                .iter()
                .filter(|path| {
                    path.contains("promotions-")
                        || path.ends_with("MEMORY.md")
                        || path.contains(&format!("{DREAM_DATA_DIR}/{DREAM_REPORTS_DIR}/deep/"))
                })
                .cloned()
                .collect(),
        },
    ]
}

#[expect(
    clippy::float_arithmetic,
    reason = "dream promotion scoring combines weighted f32 evidence signals"
)]
fn score_candidate(candidate: &DreamCandidate, rem: &RemPhaseOutput) -> f32 {
    let evidence_score = (usize_to_f32(candidate.unique_source_count) / 3.0).min(1.0);
    let recall_score = (u32_to_f32(candidate.recall_count) / 4.0).min(1.0);
    let theme_score = if candidate.theme_hits.is_empty() {
        0.0
    } else {
        let reinforced = candidate
            .theme_hits
            .iter()
            .filter_map(|theme| rem.reinforcement_signals.get(theme))
            .copied()
            .sum::<usize>();
        ((usize_to_f32(candidate.theme_hits.len()) * 0.20) + (usize_to_f32(reinforced) * 0.10))
            .min(1.0)
    };
    round_score(
        candidate.durability_score * 0.30
            + candidate.specificity_score * 0.25
            + candidate.recency_score * 0.15
            + evidence_score * 0.10
            + recall_score * 0.10
            + theme_score * 0.10,
    )
}

fn promotion_gates(candidate: &DreamCandidate, source_still_present: bool) -> Vec<DreamGate> {
    let generated_source = is_generated_dreaming_path(&candidate.source);
    let too_short = candidate.text.len() < MIN_CANDIDATE_LEN;
    let heading = is_heading_line(&candidate.text);
    let transient = is_obviously_transient(&candidate.text);

    vec![
        gate(
            "minimum_score",
            candidate.promotion_score >= MIN_PROMOTION_SCORE,
            format!(
                "index score {:.2} is below {:.2}",
                candidate.promotion_score, MIN_PROMOTION_SCORE
            ),
        ),
        gate(
            "minimum_evidence",
            !candidate.evidence.is_empty() && candidate.unique_source_count >= 1,
            "candidate has no usable source evidence".to_owned(),
        ),
        gate(
            "not_generated_from_dreaming_files",
            !generated_source,
            "generated dreaming artifacts are never index sources".to_owned(),
        ),
        gate(
            "not_too_short",
            !too_short,
            format!("candidate is shorter than {MIN_CANDIDATE_LEN} characters"),
        ),
        gate(
            "not_heading",
            !heading,
            "headings are structure, not durable memory candidates".to_owned(),
        ),
        gate(
            "not_obviously_transient",
            !transient,
            "candidate looks temporary or task-like".to_owned(),
        ),
        gate(
            "source_still_present",
            source_still_present,
            "source snippet is stale, deleted, or changed".to_owned(),
        ),
    ]
}

fn gate(name: &str, passed: bool, failure_reason: String) -> DreamGate {
    DreamGate {
        name: name.to_owned(),
        passed,
        reason: if passed {
            "passed".to_owned()
        } else {
            failure_reason
        },
    }
}

async fn source_still_contains(
    store: &MarkdownMemoryStore,
    candidate: &DreamCandidate,
) -> Result<bool, DreamingError> {
    if is_generated_dreaming_path(&candidate.source) || !is_candidate_source_path(&candidate.source)
    {
        return Ok(false);
    }
    let entry = match store.read(&candidate.source).await {
        Ok(entry) => entry,
        Err(MarkdownStoreError::NotFound(_)) => return Ok(false),
        Err(e) => return Err(DreamingError::Memory(e.to_string())),
    };
    let wanted = normalize_candidate_text(&candidate.text);
    if let Some(line) = candidate.line {
        if let Some(current) = entry.content.lines().nth(line.saturating_sub(1)) {
            if candidate_text_from_line(current)
                .is_some_and(|text| normalize_candidate_text(&text) == wanted)
            {
                return Ok(true);
            }
        }
    }
    Ok(entry
        .content
        .lines()
        .filter_map(candidate_text_from_line)
        .any(|text| normalize_candidate_text(&text) == wanted))
}

async fn write_data_json<T: Serialize>(
    character_data_dir: &Path,
    path: &Path,
    value: &T,
) -> Result<(), DreamingError> {
    let json = serde_json::to_string_pretty(value).map_err(|e| DreamingError::Io(e.to_string()))?;
    ensure_data_write_path(character_data_dir, path).await?;
    fs::write(path, json)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))
}

async fn write_data_markdown(
    character_data_dir: &Path,
    path: &Path,
    content: &str,
) -> Result<(), DreamingError> {
    ensure_data_write_path(character_data_dir, path).await?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| DreamingError::Io(e.to_string()))?;
    }
    fs::write(path, content)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))
}

async fn append_dream_diary(
    data_dir: &Path,
    character: &str,
    ran_at: &str,
    light: &LightPhaseOutput,
    rem: &RemPhaseOutput,
    deep: &DeepPhaseOutput,
) -> Result<(), DreamingError> {
    let mut body = match crate::memory::dreams_log::read_dreams_log(data_dir, character).await {
        Ok(Some(content)) => normalize_dream_diary(content),
        Ok(None) => DREAM_DIARY_HEADER.to_owned(),
        Err(e) => return Err(DreamingError::Io(e.to_string())),
    };

    let _ignored = write!(body, "## Dream Cycle - {ran_at}\n\n");
    push_light_diary_section(&mut body, light);
    push_rem_diary_section(&mut body, rem);
    push_deep_diary_section(&mut body, deep);
    body.push_str("\n### Notes for Review\n\n");
    body.push_str("- Safe to edit/delete for human review.\n");
    body.push_str("- Does not directly control memory notes or the prompt-visible index.\n\n");

    let path = crate::memory::dreams_log::dreams_log_path(data_dir, character);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| DreamingError::Io(e.to_string()))?;
    }
    fs::write(&path, body)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))
}

/// Append the diary's "Light Sleep - Staging" section.
fn push_light_diary_section(body: &mut String, light: &LightPhaseOutput) {
    body.push_str("### Light Sleep - Staging\n\n");
    _ = writeln!(body, "- Sources reviewed: {}", light.sources_reviewed);
    _ = writeln!(body, "- Candidates staged: {}", light.candidates_staged);
    _ = writeln!(body, "- Duplicates ignored: {}", light.duplicates_ignored);
    body.push_str("- No durable memory was written\n\n");

    if !light.candidates.is_empty() {
        body.push_str("Staged examples:\n\n");
        for candidate in light.candidates.iter().take(MAX_DIARY_ITEMS) {
            _ = writeln!(
                body,
                "- {}\n  - source: `{}`{}",
                diary_text(&candidate.text),
                candidate.source,
                candidate
                    .line
                    .map(|line| format!(":{line}"))
                    .unwrap_or_default()
            );
        }
        body.push('\n');
    }
}

/// Append the diary's "REM Sleep - Reflection" section.
fn push_rem_diary_section(body: &mut String, rem: &RemPhaseOutput) {
    body.push_str("### REM Sleep - Reflection\n\n");
    if rem.themes.is_empty() {
        body.push_str("- Themes noticed: none\n");
    } else {
        body.push_str("- Themes noticed:\n");
        for theme in rem.themes.iter().take(MAX_DIARY_ITEMS) {
            _ = writeln!(body, "  - {} ({} hits)", theme.theme, theme.hits);
        }
    }
    if rem.reinforcement_signals.is_empty() {
        body.push_str("- Reinforcement signals: none\n");
    } else {
        body.push_str("- Reinforcement signals:\n");
        for (theme, hits) in rem.reinforcement_signals.iter().take(MAX_DIARY_ITEMS) {
            _ = writeln!(body, "  - {theme}: {hits} supporting candidates");
        }
    }
    body.push_str("- No durable memory was written\n\n");
}

/// Append the diary's "Deep Sleep - Indexing" section.
fn push_deep_diary_section(body: &mut String, deep: &DeepPhaseOutput) {
    body.push_str("### Deep Sleep - Indexing\n\n");
    body.push_str("Indexed in `MEMORY.md`:\n\n");
    if deep.promoted.is_empty() {
        body.push_str("- None\n");
    } else {
        for promotion in deep.promoted.iter().take(MAX_DIARY_ITEMS) {
            _ = writeln!(body, "- {}", diary_text(&promotion.text));
            _ = writeln!(body, "  - score: {:.2}", promotion.score);
            if let Some(evidence) = promotion.evidence.first() {
                _ = writeln!(
                    body,
                    "  - evidence/source: `{}`{}",
                    evidence.source,
                    evidence
                        .line
                        .map(|line| format!(":{line}"))
                        .unwrap_or_default()
                );
            }
            _ = writeln!(
                body,
                "  - gates passed: {}",
                promotion.gates_passed.join(", ")
            );
        }
    }
    body.push_str("\nRejected/deferred:\n\n");
    if deep.rejected.is_empty() {
        body.push_str("- None\n");
    } else {
        for rejection in deep.rejected.iter().take(MAX_DIARY_ITEMS) {
            _ = writeln!(body, "- {}", diary_text(&rejection.text));
            _ = writeln!(body, "  - reason: {}", rejection.reason);
        }
    }
}

async fn write_phase_reports(
    character_data_dir: &Path,
    ran_at: &str,
    report_paths: PhaseReportPaths<'_>,
    light: &LightPhaseOutput,
    rem: &RemPhaseOutput,
    deep: &DeepPhaseOutput,
) -> Result<(), DreamingError> {
    let (light_report_rel, rem_report_rel, deep_report_rel) = report_paths;
    let mut light_report = format!("# Light Sleep - {ran_at}\n\n");
    let _ignored = writeln!(
        light_report,
        "- Sources reviewed: {}",
        light.sources_reviewed
    );
    _ = writeln!(
        light_report,
        "- Generated sources ignored: {}",
        light.generated_sources_ignored
    );
    _ = writeln!(
        light_report,
        "- Candidates staged: {}",
        light.candidates_staged
    );
    _ = writeln!(
        light_report,
        "- Duplicates ignored: {}",
        light.duplicates_ignored
    );
    light_report.push_str("- No durable memory was written\n");

    let mut rem_report = format!("# REM Sleep - {ran_at}\n\n");
    rem_report.push_str("## Themes\n\n");
    for theme in &rem.themes {
        _ = writeln!(rem_report, "- {}: {} hits", theme.theme, theme.hits);
    }
    if rem.themes.is_empty() {
        rem_report.push_str("- None\n");
    }
    rem_report.push_str("\nNo durable memory was written.\n");

    let mut deep_report = format!("# Deep Sleep - {ran_at}\n\n");
    deep_report.push_str("## Indexed Throughlines\n\n");
    if deep.promoted.is_empty() {
        deep_report.push_str("- None\n");
    } else {
        for promotion in &deep.promoted {
            _ = writeln!(deep_report, "- {} ({:.2})", promotion.text, promotion.score);
        }
    }
    deep_report.push_str("\n## Rejected/deferred\n\n");
    if deep.rejected.is_empty() {
        deep_report.push_str("- None\n");
    } else {
        for rejection in &deep.rejected {
            _ = writeln!(deep_report, "- {} - {}", rejection.text, rejection.reason);
        }
    }

    write_data_markdown(character_data_dir, light_report_rel, &light_report).await?;
    write_data_markdown(character_data_dir, rem_report_rel, &rem_report).await?;
    write_data_markdown(character_data_dir, deep_report_rel, &deep_report).await
}

async fn write_memory_index(
    store: &MarkdownMemoryStore,
    memory_index_path: &Path,
    character: &str,
    ran_at: &str,
    throughlines: &[DreamPromotion],
) -> Result<(), DreamingError> {
    let mut entries = store
        .list_all()
        .await
        .map_err(|e| DreamingError::Memory(e.to_string()))?
        .into_iter()
        .filter(|entry| is_candidate_source_path(&entry.path))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let mut recent = entries.clone();
    recent.sort_by(|a, b| {
        modified_sort_key(b)
            .cmp(&modified_sort_key(a))
            .then_with(|| a.path.cmp(&b.path))
    });

    let mut body = String::new();
    body.push_str("# Memory Index\n\n");
    let _ignored = writeln!(body, "Character: {character}");
    _ = write!(body, "Last updated: {ran_at}\n\n");
    body.push_str("This file is your active memory: a dated, continuously pruned scratchpad of what is live right now. It maps durable memory files in workspace/memory, recent updates, and still-relevant conversational throughlines.\n\n");
    body.push_str("It is not long-term storage — that is the job of the files under workspace/memory. It is also not the character definition, user profile, standing behavior, or tool guide. Those roles stay in SOUL.md, USER.md, AGENTS.md, and TOOLS.md.\n\n");

    push_memory_files_section(&mut body, &entries);
    push_recent_updates_section(&mut body, &recent);
    push_throughlines_section(&mut body, throughlines);

    body.push_str("\n## Use\n\n");
    body.push_str("- Treat this as a map, not a full memory dump.\n");
    body.push_str(
        "- Read or search the referenced memory files for details before relying on them.\n",
    );

    if let Some(parent) = memory_index_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| DreamingError::Io(e.to_string()))?;
    }
    fs::write(memory_index_path, body)
        .await
        .map_err(|e| DreamingError::Io(e.to_string()))
}

/// Append the index's "Memory Files" section: path-sorted entries, capped at
/// `MAX_INDEX_FILES` with an omission note.
fn push_memory_files_section(body: &mut String, entries: &[MarkdownEntry]) {
    body.push_str("## Memory Files\n\n");
    if entries.is_empty() {
        body.push_str("- No memory files yet.\n");
    } else {
        for entry in entries.iter().take(MAX_INDEX_FILES) {
            _ = writeln!(body, "- `{}` - {}", entry.path, memory_file_summary(entry));
        }
        if entries.len() > MAX_INDEX_FILES {
            _ = writeln!(
                body,
                "- {} additional memory files omitted from this index.",
                entries.len().saturating_sub(MAX_INDEX_FILES)
            );
        }
    }
}

/// Append the index's "Recently Updated" section from the recency-sorted
/// entry list.
fn push_recent_updates_section(body: &mut String, recent: &[MarkdownEntry]) {
    body.push_str("\n## Recently Updated\n\n");
    if recent.is_empty() {
        body.push_str("- No recent memory file updates.\n");
    } else {
        for entry in recent.iter().take(MAX_RECENT_INDEX_FILES) {
            _ = writeln!(
                body,
                "- `{}` - modified {}",
                entry.path,
                display_modified_at(&entry.modified_at)
            );
        }
    }
}

/// Append the index's "Conversational Throughlines" section from the latest
/// dream cycle's promotions.
fn push_throughlines_section(body: &mut String, throughlines: &[DreamPromotion]) {
    body.push_str("\n## Conversational Throughlines\n\n");
    if throughlines.is_empty() {
        body.push_str("- No high-confidence throughlines selected in the latest dream cycle.\n");
    } else {
        for item in throughlines.iter().take(MAX_INDEX_THROUGHLINES) {
            _ = writeln!(body, "- {}", diary_text(&item.text));
            if let Some(evidence) = item.evidence.first() {
                _ = writeln!(
                    body,
                    "  - source: `{}`{}",
                    evidence.source,
                    evidence
                        .line
                        .map(|line| format!(":{line}"))
                        .unwrap_or_default()
                );
            }
        }
    }
}

fn memory_file_summary(entry: &MarkdownEntry) -> String {
    let title = entry
        .content
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            trimmed
                .strip_prefix('#')
                .map(|rest| rest.trim_matches('#').trim())
                .filter(|rest| !rest.is_empty())
        })
        .unwrap_or("untitled");
    let detail_opt = entry
        .content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || is_heading_line(trimmed) {
                return None;
            }
            Some(strip_list_marker(trimmed).trim())
        })
        .find(|line| !line.is_empty());

    match detail_opt {
        Some(detail) => format!("{title}; {detail}"),
        None => title.to_owned(),
    }
}

fn modified_sort_key(entry: &MarkdownEntry) -> i64 {
    DateTime::parse_from_rfc3339(&entry.modified_at)
        .map(|dt| dt.timestamp())
        .unwrap_or_default()
}

fn display_modified_at(modified_at: &str) -> &str {
    if modified_at.is_empty() {
        "unknown"
    } else {
        modified_at
    }
}

fn update_seen_state(state: &mut DreamState, candidates: &[DreamCandidate]) {
    for candidate in candidates {
        let key = normalize_candidate_text(&candidate.text);
        let mut sources = candidate
            .evidence
            .iter()
            .map(|evidence| evidence.source.clone())
            .collect::<BTreeSet<_>>();
        if let Some(existing) = state.seen_candidates.get(&key) {
            sources.extend(existing.sources.iter().cloned());
        }
        let _ignored = state.seen_candidates.insert(
            key,
            DreamSeenState {
                first_seen_at: candidate.first_seen_at.clone(),
                last_seen_at: candidate.last_seen_at.clone(),
                recall_count: candidate.recall_count,
                sources: sources.into_iter().collect(),
            },
        );
    }
}

pub fn is_generated_dreaming_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_lowercase();
    lower == "memory.md"
        || lower == "dreams.md"
        || lower == "dreams"
        || lower == "dreams/"
        || lower.starts_with(".dreams/")
        || lower.starts_with("dreaming/")
}

fn is_candidate_source_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    !is_generated_dreaming_path(path)
        && Path::new(&normalized)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn candidate_text_from_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || is_heading_line(trimmed)
        || trimmed.starts_with("```")
        || trimmed == "---"
        || trimmed.starts_with('|')
    {
        return None;
    }
    let text = strip_list_marker(trimmed).trim();
    if text.len() < MIN_CANDIDATE_LEN || is_obviously_transient(text) {
        return None;
    }
    Some(text.to_owned())
}

fn strip_list_marker(text: &str) -> &str {
    for prefix in ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ ", "> "] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest.trim();
        }
    }
    if let Some((left, right)) = text.split_once(". ") {
        if !left.is_empty() && left.len() <= 3 && left.chars().all(|c| c.is_ascii_digit()) {
            return right.trim();
        }
    }
    text
}

fn is_heading_line(text: &str) -> bool {
    text.trim_start().starts_with('#')
}

fn is_obviously_transient(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "maybe later",
        "temporary",
        "transient",
        "scratch",
        "draft",
        "wip",
        "todo",
        "tomorrow",
        "today i",
        "today we",
        "remind me",
        "meeting at",
        "next week",
        "for now",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn source_kind(path: &str) -> &'static str {
    let lower = path.replace('\\', "/").to_lowercase();
    if lower.starts_with("daily/") || lower.starts_with("journal/") || lower.contains("/daily/") {
        "daily"
    } else if lower.contains("compact") {
        "compacted_note"
    } else {
        "curated_markdown"
    }
}

fn detect_themes(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut themes = BTreeSet::new();
    if contains_any(
        &lower,
        &[
            "likes",
            "prefers",
            "favorite",
            "favourite",
            "dislikes",
            "hates",
            "enjoys",
            "wants",
        ],
    ) {
        let _ignored = themes.insert("preference".to_owned());
    }
    if contains_any(
        &lower,
        &[
            "name is",
            "birthday",
            "born",
            "lives in",
            "pronouns",
            "calls themself",
        ],
    ) {
        let _ignored = themes.insert("identity".to_owned());
    }
    if contains_any(
        &lower,
        &["project", "working on", "building", "repo", "branch"],
    ) {
        let _ignored = themes.insert("project".to_owned());
    }
    if contains_any(
        &lower,
        &[
            "remember",
            "important",
            "promised",
            "agreed",
            "commitment",
            "must not forget",
        ],
    ) {
        let _ignored = themes.insert("commitment".to_owned());
    }
    if contains_any(
        &lower,
        &["friend", "partner", "family", "works with", "relationship"],
    ) {
        let _ignored = themes.insert("relationship".to_owned());
    }
    if contains_any(
        &lower,
        &["always", "usually", "never", "long-term", "durable"],
    ) {
        let _ignored = themes.insert("stable_context".to_owned());
    }
    themes.into_iter().collect()
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn recency_score(modified_at: &str) -> f32 {
    if let Ok(modified) = DateTime::parse_from_rfc3339(modified_at) {
        let age_days = Utc::now()
            .signed_duration_since(modified.with_timezone(&Utc))
            .num_days();
        return if age_days <= 7 {
            1.0
        } else if age_days <= 30 {
            0.8
        } else if age_days <= 180 {
            0.55
        } else {
            0.30
        };
    }
    0.50
}

#[expect(
    clippy::float_arithmetic,
    reason = "dream candidate durability is a bounded weighted f32 heuristic score"
)]
fn durability_score(text: &str, themes: &[String]) -> f32 {
    let lower = text.to_lowercase();
    let mut score = 0.20 + (usize_to_f32(themes.len()) * 0.16);
    if contains_any(
        &lower,
        &[
            "always",
            "usually",
            "prefers",
            "favorite",
            "important",
            "remember",
            "birthday",
            "name is",
            "project",
        ],
    ) {
        score += 0.25;
    }
    if text.len() >= 48 {
        score += 0.10;
    }
    round_score(score.min(1.0))
}

#[expect(
    clippy::float_arithmetic,
    reason = "dream candidate specificity is a bounded additive f32 heuristic score"
)]
fn specificity_score(text: &str) -> f32 {
    let mut score: f32 = 0.15;
    let words = text.split_whitespace().count();
    if words >= 5 {
        score += 0.25;
    }
    if words >= 9 {
        score += 0.15;
    }
    if text.chars().any(|c| c.is_ascii_digit()) {
        score += 0.10;
    }
    if text
        .split_whitespace()
        .any(|word| word.chars().next().is_some_and(char::is_uppercase) && word.len() > 2)
    {
        score += 0.20;
    }
    if text.contains(':') || text.contains('/') || text.contains('@') {
        score += 0.05;
    }
    round_score(score.min(1.0))
}

fn normalize_candidate_text(text: &str) -> String {
    strip_list_marker(text.trim())
        .trim_matches(|c: char| c == '-' || c == '*' || c == ' ' || c == '\t')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c == '.' || c == ';' || c == ',')
        .to_lowercase()
}

fn unique_source_count(evidence: &[DreamEvidence]) -> usize {
    evidence
        .iter()
        .map(|item| item.source.as_str())
        .collect::<BTreeSet<_>>()
        .len()
}

fn candidate_id(normalized: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("dc-{hash:016x}")
}

#[expect(
    clippy::float_arithmetic,
    reason = "dream scores are rounded to two decimal places for stable serialized output"
)]
fn round_score(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

fn normalize_dream_diary(existing: String) -> String {
    if existing.contains("human-readable Dream Diary") {
        let mut body = if existing.contains("prompt-visible memory index") {
            existing
        } else if let Some(cycle_start) = existing.find("## Dream Cycle") {
            format!(
                "{DREAM_DIARY_HEADER}{}",
                existing.get(cycle_start..).unwrap_or("")
            )
        } else {
            DREAM_DIARY_HEADER.to_owned()
        };
        if !body.ends_with("\n\n") {
            if !body.ends_with('\n') {
                body.push('\n');
            }
            body.push('\n');
        }
        return body;
    }
    let old = existing.trim();
    if old.is_empty() || old == "# Dreams" {
        DREAM_DIARY_HEADER.to_owned()
    } else {
        format!("{DREAM_DIARY_HEADER}<!-- Previous review output preserved below. -->\n\n{old}\n\n")
    }
}

fn diary_text(text: &str) -> String {
    text.replace('\n', " ").trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tokio::fs;

    fn local_dt(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, second)
            .single()
            .unwrap()
    }

    #[tokio::test]
    async fn dry_run_does_not_write_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let mem = character_memory_dir(&cfg_dir, "alice");
        let workspace = character_workspace_dir(&cfg_dir, "alice");
        fs::create_dir_all(&mem).await.unwrap();
        fs::write(
            mem.join("notes.md"),
            "- Alice prefers jasmine tea and remembers the blue cup.\n",
        )
        .await
        .unwrap();
        let cfg = DreamingConfig::default();
        let result = run_legacy_diagnostic_sweep(&data_dir, &cfg_dir, "alice", &cfg, true, true)
            .await
            .unwrap()
            .unwrap();
        assert!(result.dry_run);
        assert_eq!(result.paths_written.len(), 0);
        assert!(result
            .would_write_paths
            .iter()
            .any(|path| path.replace('\\', "/").contains("alice/dreams")));
        assert!(result
            .would_write_paths
            .iter()
            .any(|path| path.ends_with("MEMORY.md")));
        assert!(!data_dir.join("alice/dreams").exists());
        assert!(!mem.join(".dreams").exists());
        assert!(!mem.join("DREAMS.md").exists());
        assert!(!workspace.join("MEMORY.md").exists());
    }

    #[tokio::test]
    async fn sweep_writes_memory_index_even_without_throughlines() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let mem = character_memory_dir(&cfg_dir, "alice");
        let workspace = character_workspace_dir(&cfg_dir, "alice");
        fs::create_dir_all(&mem).await.unwrap();
        fs::write(mem.join("notes.md"), "- maybe later\n")
            .await
            .unwrap();
        let cfg = DreamingConfig::default();
        let result = run_legacy_diagnostic_sweep(&data_dir, &cfg_dir, "alice", &cfg, false, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.promoted_count, 0);
        assert!(workspace.join("MEMORY.md").exists());
        let memory = fs::read_to_string(workspace.join("MEMORY.md"))
            .await
            .unwrap();
        assert!(memory.contains("# Memory Index"));
        assert!(memory.contains("notes.md"));
        assert!(crate::memory::dreams_log::dreams_log_path(&data_dir, "alice").exists());
        assert!(data_dir.join("alice/dreams/state.json").exists());
        assert!(!mem.join(".dreams").join("state.json").exists());
    }

    #[tokio::test]
    async fn deep_indexes_only_qualified_throughlines() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let mem = character_memory_dir(&cfg_dir, "alice");
        let workspace = character_workspace_dir(&cfg_dir, "alice");
        fs::create_dir_all(&mem).await.unwrap();
        fs::write(
            mem.join("notes.md"),
            "- Alice prefers jasmine tea and remembers the blue cup.\n- maybe later\n",
        )
        .await
        .unwrap();
        let cfg = DreamingConfig::default();
        let result = run_legacy_diagnostic_sweep(&data_dir, &cfg_dir, "alice", &cfg, false, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.promoted.len(), 1);
        assert!(result.promoted[0].contains("jasmine tea"));
        let memory = fs::read_to_string(workspace.join("MEMORY.md"))
            .await
            .unwrap();
        assert!(memory.contains("# Memory Index"));
        assert!(memory.contains("notes.md"));
        assert!(memory.contains("jasmine tea"));
        assert!(!memory.contains("maybe later"));
    }

    #[tokio::test]
    async fn generated_dreaming_outputs_are_not_reingested() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let mem = character_memory_dir(&cfg_dir, "alice");
        fs::create_dir_all(mem.join(".dreams")).await.unwrap();
        fs::create_dir_all(mem.join("dreaming/light"))
            .await
            .unwrap();
        fs::write(
            mem.join("DREAMS.md"),
            "# Dreams\n\n- Alice prefers imported dream diary tea and remembers it.\n",
        )
        .await
        .unwrap();
        fs::write(
            mem.join("dreams.md"),
            "- Alice prefers lowercase dream diary tea and remembers it.\n",
        )
        .await
        .unwrap();
        fs::write(
            mem.join(".dreams/candidates.md"),
            "- Alice prefers staged dream tea and remembers it.\n",
        )
        .await
        .unwrap();
        fs::write(
            mem.join("dreaming/light/2026-04-26.md"),
            "- Alice prefers phase report tea and remembers it.\n",
        )
        .await
        .unwrap();
        fs::write(
            mem.join("notes.md"),
            "- Alice prefers real tea and remembers it.\n",
        )
        .await
        .unwrap();

        let cfg = DreamingConfig::default();
        let result = run_legacy_diagnostic_sweep(&data_dir, &cfg_dir, "alice", &cfg, true, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.candidate_count, 1);
        assert!(result.candidates[0].text.contains("real tea"));
    }

    #[tokio::test]
    async fn existing_memory_index_is_regenerated_not_reingested() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let mem = character_memory_dir(&cfg_dir, "alice");
        let workspace = character_workspace_dir(&cfg_dir, "alice");
        fs::create_dir_all(&mem).await.unwrap();
        fs::create_dir_all(&workspace).await.unwrap();
        fs::write(
            workspace.join("MEMORY.md"),
            "# Memory Index\n\n- Alice prefers stale index tea and remembers it.\n",
        )
        .await
        .unwrap();
        fs::write(
            mem.join("notes.md"),
            "- Alice prefers jasmine tea and remembers the blue cup.\n",
        )
        .await
        .unwrap();

        let cfg = DreamingConfig::default();
        let result = run_legacy_diagnostic_sweep(&data_dir, &cfg_dir, "alice", &cfg, false, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.promoted_count, 1);
        let memory = fs::read_to_string(workspace.join("MEMORY.md"))
            .await
            .unwrap();
        assert!(memory.contains("# Memory Index"));
        assert!(memory.contains("jasmine tea"));
        assert!(!memory.contains("stale index tea"));
    }

    #[test]
    fn due_and_schedule_validation_still_work() {
        let cfg = DreamingConfig {
            frequency: "0 0 * * *".to_owned(),
            ..DreamingConfig::default()
        };
        assert!(is_due(&cfg, None).is_ok());
        let invalid = DreamingConfig {
            frequency: "bad schedule".to_owned(),
            ..DreamingConfig::default()
        };
        assert!(matches!(
            is_due(&invalid, None),
            Err(DreamingError::Schedule(_))
        ));
    }

    #[test]
    fn weekly_cron_due_only_within_max_lateness_window() {
        // 2h max_lateness (the production default): an occurrence fires only
        // if `now` is within 2 hours of the scheduled time. Beyond that, it
        // is skipped and we wait for the next cron occurrence.
        let cfg = DreamingConfig {
            frequency: "0 6 * * 1".to_owned(),
            ..DreamingConfig::default()
        };
        let before_monday = local_dt(2026, 5, 11, 5, 59, 0);
        let monday_within_window = local_dt(2026, 5, 11, 6, 1, 0);
        let monday_just_in_window = local_dt(2026, 5, 11, 7, 59, 0);
        let monday_past_window = local_dt(2026, 5, 11, 9, 0, 0);
        let tuesday = local_dt(2026, 5, 12, 9, 0, 0);
        let already_ran = local_dt(2026, 5, 11, 6, 2, 0).to_rfc3339();
        let stale_run = local_dt(2026, 5, 4, 6, 2, 0).to_rfc3339();

        assert!(!is_due_at(&cfg, None, before_monday).unwrap());
        assert!(is_due_at(&cfg, None, monday_within_window).unwrap());
        assert!(is_due_at(&cfg, None, monday_just_in_window).unwrap());
        assert!(!is_due_at(&cfg, None, monday_past_window).unwrap());
        // Past Monday entirely: out of window, next occurrence is next Monday.
        assert!(!is_due_at(&cfg, None, tuesday).unwrap());
        assert!(!is_due_at(&cfg, Some(&already_ran), tuesday).unwrap());
        // Stale prior run: walk past missed occurrences, skip the
        // out-of-window Monday, find no in-window occurrence — return false.
        assert!(!is_due_at(&cfg, Some(&stale_run), tuesday).unwrap());
    }

    #[test]
    fn max_lateness_window_walks_past_multiple_stale_occurrences() {
        // Hourly cron, missed by 5 hours with a 2h window. The walker must
        // skip every out-of-window occurrence and end up returning false
        // (the next firing-eligible occurrence is in the future).
        let cfg = DreamingConfig {
            frequency: "0 * * * *".to_owned(),
            ..DreamingConfig::default()
        };
        let last_run = local_dt(2026, 5, 11, 0, 0, 0).to_rfc3339();
        let now = local_dt(2026, 5, 11, 5, 30, 0);
        // Occurrences: 1:00, 2:00, 3:00 (>2h stale), 4:00 (1.5h stale, fires).
        assert!(is_due_at(&cfg, Some(&last_run), now).unwrap());

        // Same setup but `now` is 8.5 hours past 0:00 — the walker skips
        // 1:00–6:00 (all >2h stale) and fires on 7:00 (1.5h stale, within
        // window).
        let now_past = local_dt(2026, 5, 11, 8, 30, 0);
        assert!(is_due_at(&cfg, Some(&last_run), now_past).unwrap());

        // Truly past every occurrence: hourly cron with no occurrence in
        // window, last_run far enough back that the walker skips many.
        // Use a daily cron at 6 AM so there's only one occurrence per day.
        let daily_cfg = DreamingConfig {
            frequency: "0 6 * * *".to_owned(),
            ..DreamingConfig::default()
        };
        let stale_run = local_dt(2026, 5, 9, 6, 0, 0).to_rfc3339();
        let now_truly_past = local_dt(2026, 5, 11, 10, 0, 0);
        // May 10 6:00 is 28h stale, May 11 6:00 is 4h stale — both out of
        // 2h window. No firing-eligible occurrence.
        assert!(!is_due_at(&daily_cfg, Some(&stale_run), now_truly_past).unwrap());
    }

    #[test]
    fn custom_max_lateness_respected() {
        // Override the default 2h window to 10 minutes — a 15-minute-late
        // tick should now be considered stale.
        let cfg = DreamingConfig {
            frequency: "0 6 * * *".to_owned(),
            max_lateness: shore_config::ConfigDuration::from_secs(10 * 60),
            ..DreamingConfig::default()
        };
        let within = local_dt(2026, 5, 11, 6, 9, 0);
        let past = local_dt(2026, 5, 11, 6, 11, 0);
        assert!(is_due_at(&cfg, None, within).unwrap());
        assert!(!is_due_at(&cfg, None, past).unwrap());
    }

    #[test]
    fn far_past_last_run_with_minutely_cron_is_bounded() {
        // Minutely cron with a last_run a full year in the past would, without
        // the lateness-window clamp, walk ~525k occurrences. The clamp starts
        // the search at `now - max_lateness - 1min`, so this returns promptly
        // with the same answer as a recent in-window occurrence.
        let cfg = DreamingConfig {
            frequency: "* * * * *".to_owned(),
            max_lateness: shore_config::ConfigDuration::from_secs(5 * 60),
            ..DreamingConfig::default()
        };
        let last_run = local_dt(2025, 5, 11, 12, 0, 0).to_rfc3339();
        let now = local_dt(2026, 5, 11, 12, 0, 30);
        // The 12:00 occurrence is 30s stale — within the 5min window, so due.
        assert!(is_due_at(&cfg, Some(&last_run), now).unwrap());
    }

    #[tokio::test]
    async fn dream_status_reads_legacy_state_when_data_state_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let mem = character_memory_dir(&cfg_dir, "alice");
        fs::create_dir_all(mem.join(".dreams")).await.unwrap();
        let legacy_state = DreamState {
            last_run_at: Some("2026-04-01T00:00:00+00:00".to_owned()),
            runs: 7,
            ..DreamState::default()
        };
        let legacy_json = serde_json::to_string_pretty(&legacy_state).unwrap();
        fs::write(mem.join(".dreams/state.json"), legacy_json)
            .await
            .unwrap();

        let cfg = DreamingConfig::default();
        let status = dream_status(&data_dir, &cfg_dir, "alice", &cfg)
            .await
            .unwrap();

        assert_eq!(
            status.last_run_at.as_deref(),
            Some("2026-04-01T00:00:00+00:00")
        );
        assert!(status
            .state_path
            .replace('\\', "/")
            .ends_with("alice/dreams/state.json"));
        assert!(!data_dir.join("alice/dreams/state.json").exists());
    }

    // sweep_rejects_symlinked_dream_report_escape: removed.
    // The DREAMS.md log no longer lives in the workspace memory store; it is
    // written directly to `data_dir/{character}/DREAMS.md`, so the markdown-
    // store symlink-escape protection no longer applies to this path.

    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_rejects_symlinked_dream_state_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg_dir = tmp.path().join("config");
        let data_dir = tmp.path().join("data");
        let character_data_dir = data_dir.join("alice");
        let mem = character_memory_dir(&cfg_dir, "alice");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&mem).await.unwrap();
        fs::create_dir_all(&character_data_dir).await.unwrap();
        fs::create_dir_all(&outside).await.unwrap();
        fs::write(
            mem.join("notes.md"),
            "- Alice prefers jasmine tea and remembers the blue cup.\n",
        )
        .await
        .unwrap();
        std::os::unix::fs::symlink(&outside, character_data_dir.join("dreams")).unwrap();

        let cfg = DreamingConfig::default();
        assert!(matches!(
            run_legacy_diagnostic_sweep(&data_dir, &cfg_dir, "alice", &cfg, false, true).await,
            Err(DreamingError::Io(_))
        ));
        assert!(!outside.join("state.json").exists());
    }

    #[test]
    fn librarian_git_gate_allows_live_commits_and_blocks_dry_runs() {
        // Live: git is the pass's own bookkeeping, and the tool cannot reach
        // any other program, so it passes straight through.
        assert!(blocked_librarian_tool_result("git", false).is_none());

        // Dry run runs no commands at all, git included.
        let (dry_msg, dry_is_error) = blocked_librarian_tool_result("git", true).unwrap();
        assert!(dry_is_error);
        assert!(dry_msg.contains("dry-run"));

        // Dry run also blocks the writes themselves.
        let (edit_msg, edit_is_error) = blocked_librarian_tool_result("edit", true).unwrap();
        assert!(edit_is_error);
        assert!(edit_msg.contains("dry-run"));
        assert!(blocked_librarian_tool_result("edit", false).is_none());
    }

    #[test]
    fn librarian_tool_defs_offer_mutating_tools_only_when_live() {
        let names = |dry_run: bool| -> Vec<String> {
            build_librarian_tool_defs("alice", "Alice", dry_run)
                .iter()
                .filter_map(|def| def.get("name").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        };
        let live = names(false);
        assert!(live.iter().any(|n| n == "git"));
        assert!(live.iter().any(|n| n == "edit"));
        let dry = names(true);
        assert!(!dry.iter().any(|n| n == "git"));
        assert!(!dry.iter().any(|n| n == "edit"));
        // Inspection is available either way.
        assert!(dry.iter().any(|n| n == "read"));
        assert!(dry.iter().any(|n| n == "search"));
    }
}
