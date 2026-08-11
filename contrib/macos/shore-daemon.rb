class ShoreDaemon < Formula
  desc "Persistent AI character engine — daemon"
  homepage "https://github.com/mythofmeat/shore"
  url "https://github.com/mythofmeat/shore/archive/refs/tags/v4.6.2.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license any_of: ["MIT", "Apache-2.0"]
  head "https://github.com/mythofmeat/shore.git", branch: "main"

  depends_on "bun" => :build
  depends_on "git"

  def install
    cd "daemon" do
      system "bun", "install"
      system "bun", "build", "src/daemon/run.ts", "--compile", "--outfile", "shore-daemon"
      bin.install "shore-daemon"
    end
  end

  def config_dir
    Pathname(Dir.home)/".config/shore"
  end

  service do
    run opt_bin/"shore-daemon"
    keep_alive crashed: true
    working_dir "#{Dir.home}/.config/shore"
    environment_variables PATH: std_service_path_env, RUST_LOG: "warn"
    log_path var/"log/shore-daemon.log"
    error_log_path var/"log/shore-daemon.log"
  end

  def caveats
    <<~EOS
      The daemon reads provider credentials from the environment, and a launchd
      agent does not inherit your shell. It runs with #{config_dir} as its
      working directory, so put keys in #{config_dir}/.env:

        mkdir -p #{config_dir} && chmod 700 #{config_dir}
        printf 'ANTHROPIC_API_KEY=sk-ant-...\\n' >> #{config_dir}/.env
        chmod 600 #{config_dir}/.env

      That directory must exist before `brew services start shore-daemon`;
      launchd fails the job if its working directory is missing.

      Config lives in #{config_dir}/config.toml, written on first run.
    EOS
  end

  test do
    ENV["SHORE_CONFIG_DIR"] = testpath/"config"
    ENV["SHORE_DATA_DIR"] = testpath/"data"
    ENV["SHORE_RUNTIME_DIR"] = testpath/"runtime"
    ENV["SHORE_CACHE_DIR"] = testpath/"cache"

    port = free_port
    pid = spawn bin/"shore-daemon", "--addr", "127.0.0.1:#{port}"

    begin
      registry = testpath/"runtime/instances.json"
      sleep 10
      assert_path_exists registry
      assert_match "127.0.0.1:#{port}", registry.read
      assert_path_exists testpath/"config/config.toml"
    ensure
      Process.kill "TERM", pid
      Process.wait pid
    end
  end
end
