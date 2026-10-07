# frozen_string_literal: true

# The release workflow builds Shore.app with desktop/scripts/macos-app.ts, attaches its zip to the release, and
# moves the version and checksum below.
#   brew tap mythofmeat/shore https://github.com/mythofmeat/shore.git
#   brew install --cask mythofmeat/shore/shore-desktop
cask "shore-desktop" do
  version "4.26.0"
  sha256 "1a3167b06baa20e22100a882c00ad46c7b20d0b5a64da20f51130ba7a5019e96"

  url "https://github.com/mythofmeat/shore/releases/download/v#{version}/Shore-#{version}-arm64.zip"
  name "Shore"
  desc "Desktop app for the shore AI character engine's browser client"
  homepage "https://github.com/mythofmeat/shore"

  depends_on arch: :arm64
  depends_on :macos

  app "Shore.app"
  # Electron finds its helper apps from the path it ran as, so a link to it can't start; a wrapper can.
  command_wrapper "shore-desktop", executable: "#{appdir}/Shore.app/Contents/MacOS/Shore"

  # Shore.app is signed ad hoc, not notarized, so macOS would make you approve it in System Settings after every
  # install and upgrade while Homebrew's quarantine flag is on it.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Shore.app"]
  end

  zap trash: "~/Library/Application Support/shore-desktop"
end
