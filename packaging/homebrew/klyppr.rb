# Homebrew Cask for Klyppr.
#
# This file lives in YOUR tap repo, not here — copy it to:
#   github.com/muzafferkadir/homebrew-tap  →  Casks/klyppr.rb
# Then users install with:
#   brew install --cask muzafferkadir/tap/klyppr
#
# After the first release, fill in the two sha256 values (shasum -a 256 of each
# .dmg asset) and bump `version`. `auto_updates true` tells brew the app updates
# itself (via the in-app updater), so `brew upgrade` won't fight it. The
# postflight strips quarantine so the ad-hoc-signed (unsigned) app opens without
# a Gatekeeper prompt.

cask "klyppr" do
  version "3.0.0"

  on_arm do
    sha256 "REPLACE_WITH_ARM_DMG_SHA256"
    url "https://github.com/muzafferkadir/klyppr-desktop/releases/download/v#{version}/Klyppr_#{version}_aarch64.dmg"
  end
  on_intel do
    sha256 "REPLACE_WITH_X64_DMG_SHA256"
    url "https://github.com/muzafferkadir/klyppr-desktop/releases/download/v#{version}/Klyppr_#{version}_x64.dmg"
  end

  name "Klyppr"
  desc "Automatic video silence clipper"
  homepage "https://github.com/muzafferkadir/klyppr-desktop"

  auto_updates true
  depends_on macos: ">= :big_sur"

  app "Klyppr.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Klyppr.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.klyppr.app",
    "~/Library/Caches/com.klyppr.app",
    "~/Library/Preferences/com.klyppr.app.plist",
  ]
end
