#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="/Users/zhanshiqing/shanghai-bus-radar"
SHARED_TOOLS="/Users/zhanshiqing/laundry-rain-guard/.android-toolchain"
TOOLS_DIR="$BASE_DIR/.android-toolchain"
PROJ_DIR="$BASE_DIR/android-apk-project/app/src/main"
BUILD_DIR="$BASE_DIR/.apk-build"
OUT_APK="$BASE_DIR/知途实时公交.apk"

mkdir -p "$BUILD_DIR"

if [ -d "$SHARED_TOOLS/jdk" ] && [ -d "$SHARED_TOOLS/build-tools" ] && [ -f "$SHARED_TOOLS/android.jar" ]; then
  TOOLS_DIR="$SHARED_TOOLS"
  echo "[1/5] Reusing portable JDK 17 & Android Build Tools 34 from $TOOLS_DIR..."
else
  mkdir -p "$TOOLS_DIR"
  echo "[1/5] Preparing portable JDK 17..."
  if [ ! -d "$TOOLS_DIR/jdk" ]; then
    curl -sL "https://cdn.azul.com/zulu/bin/zulu17.50.19-ca-jdk17.0.11-macosx_aarch64.tar.gz" -o "$TOOLS_DIR/jdk17.tar.gz"
    mkdir -p "$TOOLS_DIR/jdk"
    tar -xzf "$TOOLS_DIR/jdk17.tar.gz" -C "$TOOLS_DIR/jdk" --strip-components=1
    rm -f "$TOOLS_DIR/jdk17.tar.gz"
  fi

  echo "[2/5] Preparing Android Build Tools 34 & Platform 33..."
  if [ ! -d "$TOOLS_DIR/build-tools" ]; then
    curl -sL "https://dl.google.com/android/repository/build-tools_r34-macosx.zip" -o "$TOOLS_DIR/bt.zip"
    unzip -q "$TOOLS_DIR/bt.zip" -d "$TOOLS_DIR/build-tools-tmp"
    mv "$TOOLS_DIR/build-tools-tmp"/android-* "$TOOLS_DIR/build-tools"
    rm -rf "$TOOLS_DIR/bt.zip" "$TOOLS_DIR/build-tools-tmp"
  fi

  if [ ! -f "$TOOLS_DIR/android.jar" ]; then
    curl -sL "https://dl.google.com/android/repository/platform-33_r02.zip" -o "$TOOLS_DIR/pf.zip"
    unzip -q -j "$TOOLS_DIR/pf.zip" "*/android.jar" -d "$TOOLS_DIR"
    rm -f "$TOOLS_DIR/pf.zip"
  fi
fi

export JAVA_HOME="$TOOLS_DIR/jdk/zulu-17.jdk/Contents/Home"
if [ ! -d "$JAVA_HOME" ]; then
  export JAVA_HOME="$TOOLS_DIR/jdk"
fi
export PATH="$JAVA_HOME/bin:$PATH"

AAPT2="$TOOLS_DIR/build-tools/aapt2"
D8="$TOOLS_DIR/build-tools/d8"
ZIPALIGN="$TOOLS_DIR/build-tools/zipalign"
APKSIGNER="$TOOLS_DIR/build-tools/apksigner"
ANDROID_JAR="$TOOLS_DIR/android.jar"

echo "[3/5] Compiling resources & generating R.java..."
python3 - << 'PYEOF'
from pathlib import Path
assets = Path("/Users/zhanshiqing/shanghai-bus-radar/android-apk-project/app/src/main/assets")
tpl = assets / "template.html"
if not tpl.exists():
    tpl.write_text((assets / "index.html").read_text(encoding="utf-8"), encoding="utf-8")
html = tpl.read_text(encoding="utf-8")
css = (assets / "styles.css").read_text(encoding="utf-8")
js_data = (assets / "data.js").read_text(encoding="utf-8")
js_detail = (assets / "detail.js").read_text(encoding="utf-8")
js_app = (assets / "app.js").read_text(encoding="utf-8")
bundled = html.replace('<link rel="stylesheet" href="styles.css" />', f"<style>\n{css}\n</style>")
bundled = bundled.replace(
    '  <script src="data.js"></script>\n  <script src="detail.js"></script>\n  <script src="app.js"></script>',
    f"<script>\n{js_data}\n{js_detail}\n{js_app}\n</script>"
)
Path("/Users/zhanshiqing/shanghai-bus-radar/index.html").write_text(bundled, encoding="utf-8")
(assets / "index.html").write_text(bundled, encoding="utf-8")
PYEOF
rm -rf "$BUILD_DIR"/*
mkdir -p "$BUILD_DIR/compiled_res" "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex"

"$AAPT2" compile --dir "$PROJ_DIR/res" -o "$BUILD_DIR/compiled_res/res.zip"
"$AAPT2" link \
  -I "$ANDROID_JAR" \
  --manifest "$PROJ_DIR/AndroidManifest.xml" \
  -A "$PROJ_DIR/assets" \
  --java "$BUILD_DIR/gen" \
  -o "$BUILD_DIR/unaligned.apk" \
  "$BUILD_DIR/compiled_res/res.zip"

echo "[4/5] Compiling Java sources & converting to DEX..."
JAVA_FILES=$(find "$PROJ_DIR/java" "$BUILD_DIR/gen" -name "*.java")
javac -source 11 -target 11 -encoding UTF-8 \
  -cp "$ANDROID_JAR" \
  -d "$BUILD_DIR/classes" \
  $JAVA_FILES

CLASS_FILES=$(find "$BUILD_DIR/classes" -name "*.class")
"$D8" --lib "$ANDROID_JAR" --output "$BUILD_DIR/dex" $CLASS_FILES

cd "$BUILD_DIR/dex"
zip -q "$BUILD_DIR/unaligned.apk" classes.dex
cd "$BASE_DIR"

echo "[5/5] Aligning & signing standalone APK..."
"$ZIPALIGN" -f -p 4 "$BUILD_DIR/unaligned.apk" "$BUILD_DIR/aligned.apk"

KEYSTORE="$BASE_DIR/.apk-build/bus-release-key.jks"
if [ -f "$TOOLS_DIR/release-key.jks" ]; then
  KEYSTORE="$TOOLS_DIR/release-key.jks"
  KEY_ALIAS="jingan_laundry_key"
else
  KEY_ALIAS="shanghai_bus_key"
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass 123456 -keypass 123456 \
    -dname "CN=ShanghaiBusRadar, OU=Transit, O=Standalone, L=Shanghai, ST=Shanghai, C=CN"
fi

"$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass pass:123456 \
  --key-pass pass:123456 \
  --v4-signing-enabled false \
  --out "$OUT_APK" \
  "$BUILD_DIR/aligned.apk"

rm -f "$OUT_APK.idsig" "$BASE_DIR/申城实时公交.apk" "$BASE_DIR/申城实时公交.apk.idsig"

"$APKSIGNER" verify --verbose "$OUT_APK"
ls -lh "$OUT_APK"
echo "APK Successfully Built: $OUT_APK"
