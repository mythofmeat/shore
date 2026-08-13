class ShoreTui < Formula
  desc "Persistent AI character engine — terminal client"
  homepage "https://github.com/mythofmeat/shore"
  url "https://github.com/mythofmeat/shore/archive/refs/tags/v4.6.2.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license any_of: ["MIT", "Apache-2.0"]
  head "https://github.com/mythofmeat/shore.git", branch: "main"

  depends_on "rust" => :build

  def install
    system "cargo", "install", *std_cargo_args(path: "client/shore-tui")
  end

  test do
    assert_match "Shore terminal UI", shell_output("#{bin}/shore-tui --help")
  end
end
