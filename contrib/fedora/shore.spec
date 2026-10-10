# Built by .github/workflows/package.yml from a `git archive` of the checkout. cargo and bun aren't
# BuildRequires: CI installs current stable Rust with rustup and the bun daemon/.bun-version pins, since the
# weekly dependency updates can need a newer Rust than Fedora ships.

# Fedora packages no Electron, so shore-desktop carries its own. Its libraries stay private to it.
%global debug_package %{nil}
%global _build_id_links none
%global __strip /bin/true
%global __provides_exclude_from ^%{_libdir}/shore-desktop/.*$
%global __requires_exclude ^lib(EGL|GLESv2|ffmpeg|vk_swiftshader|vulkan)\\.so.*$

Name:           shore
Version:        4.31.1
Release:        1%{?dist}
Summary:        Persistent AI character engine
License:        MIT OR Apache-2.0
URL:            https://github.com/mythofmeat/shore
Source0:        %{name}-%{version}.tar.gz

BuildRequires:  gcc
BuildRequires:  unzip

%description
Persistent AI character engine.

%package -n shore-cli
Summary:        Persistent AI character engine — CLI and terminal chat client
Recommends:     wl-clipboard
Suggests:       yazi

%description -n shore-cli
The shore command and its terminal chat client.

%package -n shore-desktop
Summary:        Persistent AI character engine — desktop app for the daemon's browser client
License:        (MIT OR Apache-2.0) AND OFL-1.1 AND MIT AND BSD-3-Clause
Requires:       libnotify
Requires:       xdg-utils

%description -n shore-desktop
A desktop window for the shore daemon's browser client, with its own Electron.

%prep
%autosetup

%build
# Fedora's RUSTFLAGS add full debug info and turn stripping off, which would override the client's release profile.
unset RUSTFLAGS
cd client
cargo build --release --locked --bin shore
cd ../desktop
bun install --frozen-lockfile
bun run app:linux

%install
install -Dm755 client/target/release/shore %{buildroot}%{_bindir}/shore
install -dm755 %{buildroot}%{_datadir}/fish/vendor_completions.d
install -dm755 %{buildroot}%{_datadir}/bash-completion/completions
install -dm755 %{buildroot}%{_datadir}/zsh/site-functions
client/target/release/shore completions fish >%{buildroot}%{_datadir}/fish/vendor_completions.d/shore.fish
client/target/release/shore completions bash >%{buildroot}%{_datadir}/bash-completion/completions/shore
client/target/release/shore completions zsh >%{buildroot}%{_datadir}/zsh/site-functions/_shore

install -dm755 %{buildroot}%{_libdir}
cp -r --no-preserve=ownership out/desktop/shore-desktop-linux-* %{buildroot}%{_libdir}/shore-desktop
# Chromium falls back to this helper where unprivileged user namespaces are off, and it only works setuid.
chmod 4755 %{buildroot}%{_libdir}/shore-desktop/chrome-sandbox
install -dm755 %{buildroot}%{_bindir}
ln -s ../%{_lib}/shore-desktop/shore-desktop %{buildroot}%{_bindir}/shore-desktop
install -Dm644 desktop/shore-desktop.desktop %{buildroot}%{_datadir}/applications/shore-desktop.desktop
install -Dm644 desktop/assets/shore.svg %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/shore-desktop.svg
install -Dm644 desktop/assets/shore.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/shore-desktop.png

%files -n shore-cli
%license LICENSE-MIT LICENSE-APACHE-2.0
%{_bindir}/shore
%{_datadir}/fish/vendor_completions.d/shore.fish
%{_datadir}/bash-completion/completions/shore
%{_datadir}/zsh/site-functions/_shore

%files -n shore-desktop
%license LICENSE-MIT LICENSE-APACHE-2.0
%license desktop/dist/shell/fonts/LICENSE-Geist.txt desktop/dist/shell/fonts/LICENSE-GeistMono.txt
%{_bindir}/shore-desktop
%{_libdir}/shore-desktop/
%{_datadir}/applications/shore-desktop.desktop
%{_datadir}/icons/hicolor/scalable/apps/shore-desktop.svg
%{_datadir}/icons/hicolor/512x512/apps/shore-desktop.png
