pub mod active_character;
pub mod dirs;
pub mod duration;
pub mod image_protocol;
pub mod protocol;
pub mod swp_client;
pub mod token;

pub const BUILD_VERSION: &str = env!("SHORE_VERSION");

#[cfg(test)]
mod test_env;
