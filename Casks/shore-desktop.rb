# frozen_string_literal: true

cask "shore-desktop" do
  version "4.40.0"
  sha256 "0776486413e358d8b8c8b58202be10363d97ee4e3d72bb7acae258ead2bb8721"

  url "https://github.com/mythofmeat/shore/releases/download/v#{version}/Shore-#{version}-arm64.zip"
  name "Shore"
  desc "Desktop app for the shore AI character engine's browser client"
  homepage "https://github.com/mythofmeat/shore"

  depends_on arch: :arm64
  depends_on :macos

  app "Shore.app"
  command_wrapper "shore-desktop", executable: "#{appdir}/Shore.app/Contents/MacOS/Shore"

  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Shore.app"]
  end

  zap trash: "~/Library/Application Support/shore-desktop"
end
