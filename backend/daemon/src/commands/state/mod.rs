mod config;
mod memory;
mod models;
mod status;

pub use config::{config, config_check, config_reload, config_reset, tools};
pub use memory::{compact, memory, memory_changelog, memory_dream, memory_dreams};
pub use models::{
    background_models, list_models, list_models_with_args, model_info, model_settings, reset_model,
    set_model_setting, switch_model,
};
pub use status::{
    call_log, diagnostics, heartbeat_log, heartbeat_set_active, heartbeat_set_dormant,
    heartbeat_tick_now, status, transcript,
};

#[cfg(test)]
mod tests;
