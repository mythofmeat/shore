# frozen_string_literal: true

# Builds Shore.app on the Mac that installs it. Homebrew quarantines a cask's download, so an app
# that isn't notarized would have to be approved in System Settings after every install and upgrade.
#   brew tap mythofmeat/shore https://github.com/mythofmeat/shore.git
#   brew install mythofmeat/shore/shore-desktop
# The release workflow moves the tag below with every release.
class ShoreDesktop < Formula
  desc "Desktop app for the shore AI character engine's browser client"
  homepage "https://github.com/mythofmeat/shore"
  url "https://github.com/mythofmeat/shore.git",
      tag: "v4.20.0"
  license all_of: [
    { any_of: ["MIT", "Apache-2.0"] },
    "OFL-1.1", # the Geist fonts
    "MIT", # Electron
    "BSD-3-Clause", # Chromium, inside Electron
  ]

  depends_on "bun" => :build
  depends_on arch: :arm64
  depends_on :macos

  # Homebrew points every dylib ID that isn't @rpath-relative at the keg, which would break Shore.app's signature.
  preserve_rpath
  # Electron's empty .lproj directories tell macOS which languages its own menus and dialogs may use.
  skip_clean "Shore.app"

  # desktop/tests/homebrew.test.ts keeps this on the Electron that desktop/bun.lock pins.
  resource "electron" do
    url "https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-darwin-arm64.zip"
    sha256 "1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c"
  end

  def install
    cd "desktop" do
      system "bun", "run", "build"
    end

    resource("electron").stage buildpath/"electron"
    app = buildpath/"electron/Electron.app"
    contents = app/"Contents"
    mv contents/"MacOS/Electron", contents/"MacOS/Shore"
    rm [contents/"Resources/default_app.asar", contents/"Resources/electron.icns"]
    (contents/"Resources").install "desktop/assets/shore.icns"
    (contents/"Resources/app").install "desktop/package.json", "desktop/dist"

    plist = contents/"Info.plist"
    {
      "CFBundleDisplayName"        => "Shore",
      "CFBundleExecutable"         => "Shore",
      "CFBundleIconFile"           => "shore.icns",
      "CFBundleIdentifier"         => "com.mythofmeat.shore",
      "CFBundleName"               => "Shore",
      "CFBundleShortVersionString" => version.to_s,
      "CFBundleVersion"            => version.to_s,
    }.each { |key, value| system "plutil", "-replace", key, "-string", value, plist }
    # These describe Electron's default app, which is gone.
    %w[ElectronAsarIntegrity LSApplicationCategoryType].each { |key| system "plutil", "-remove", key, plist }

    # The one library whose ID isn't @rpath-relative, and its header has no room for the keg path
    # Homebrew would give it.
    libffmpeg = contents/"Frameworks/Electron Framework.framework/Libraries/libffmpeg.dylib"
    MachO::Tools.change_dylib_id libffmpeg, "@rpath/libffmpeg.dylib"
    # Ad-hoc, not notarized: Apple silicon won't run a binary without a valid signature, and Electron
    # ships only the linker's ad-hoc ones, which the changes above invalidate.
    system "codesign", "--force", "--sign", "-", libffmpeg
    system "codesign", "--force", "--deep", "--sign", "-", app

    prefix.install app => "Shore.app"
    prefix.install "electron/LICENSE" => "LICENSE-Electron"
    prefix.install "electron/LICENSES.chromium.html"
    (bin/"shore-desktop").write_env_script prefix/"Shore.app/Contents/MacOS/Shore", {}
  end

  def caveats
    <<~EOS
      Shore.app was installed to:
        #{opt_prefix}/Shore.app

      Run it with `shore-desktop`, or open it from there.
    EOS
  end

  test do
    system "codesign", "--verify", "--deep", "--strict", prefix/"Shore.app"
    assert_predicate prefix/"Shore.app/Contents/Resources/fr.lproj", :directory?
    plist = prefix/"Shore.app/Contents/Info.plist"
    assert_equal version.to_s, shell_output("plutil -extract CFBundleShortVersionString raw #{plist}").chomp
  end
end
