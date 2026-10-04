# frozen_string_literal: true

# This repository is its own tap:
#   brew tap mythofmeat/shore https://github.com/mythofmeat/shore.git
#   brew install mythofmeat/shore/shore
# The release workflow moves the tag below with every release.
class Shore < Formula
  desc "Terminal chat client for the shore AI character engine"
  homepage "https://github.com/mythofmeat/shore"
  url "https://github.com/mythofmeat/shore.git",
      tag: "v4.24.3"
  license any_of: ["MIT", "Apache-2.0"]

  depends_on "rust" => :build

  def install
    cd "client" do
      system "cargo", "install", "--root", prefix, "--path", "shore-cli"
    end

    generate_completions_from_executable(bin/"shore", "completions")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/shore --version")
  end
end
