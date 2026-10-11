# Unity Game Development Integration

Integration for Unity Editor and runtime workflows including build automation, testing, and deployment.

## Overview

The Unity integration provides:
- Editor automation via CLI
- Build pipeline integration
- Automated testing (EditMode/PlayMode)
- Asset pipeline management
- Deployment to multiple platforms

## Setup

### Prerequisites
- Unity 2022.3 LTS or 6000.x
- Unity Hub installed
- Platform SDKs (Android, iOS, WebGL, etc.)
- ox CLI v0.4.0+

### Installation

```bash
# Add Unity integration
ox integrations add unity

# Verify Unity installation
ox unity doctor
```

### Configuration

Create `.ox/unity.json`:

```json
{
  "unityPath": "/Applications/Unity/Hub/Editor/2022.3.20f1/Unity.app/Contents/MacOS/Unity",
  "projectPath": ".",
  "license": "${UNITY_LICENSE}",
  "platforms": ["StandaloneOSX", "StandaloneWindows64", "WebGL", "Android", "iOS"],
  "buildTargets": {
    "development": {
      "scriptingBackend": "Mono2x",
      "developmentBuild": true,
      "compression": "LZ4"
    },
    "release": {
      "scriptingBackend": "IL2CPP",
      "developmentBuild": false,
      "compression": "LZ4HC"
    }
  },
  "testing": {
    "editMode": true,
    "playMode": true,
    "coverage": true,
    "testFilters": ["*Integration*", "!Slow*"]
  },
  "assetPipeline": {
    "forceReserialize": false,
    "cacheServer": "localhost:8125",
    "addressables": true
  },
  "cloudBuild": {
    "enabled": false,
    "projectId": "",
    "apiKey": "${UNITY_CLOUD_BUILD_API_KEY}"
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UNITY_LICENSE` | Yes (CI) | Base64-encoded Unity license |
| `UNITY_EMAIL` | No | Unity account email |
| `UNITY_PASSWORD` | No | Unity account password |
| `UNITY_CLOUD_BUILD_API_KEY` | No | Cloud Build API key |
| `ANDROID_SDK_ROOT` | Android | Android SDK path |
| `JAVA_HOME` | Android | JDK 17+ path |

### License Setup (CI)

```bash
# Encode license
cat ~/Library/Application\ Support/Unity/Unity_lic.ulf | base64 -w 0

# Add to CI secrets as UNITY_LICENSE
# GitHub Actions example:
# UNITY_LICENSE: ${{ secrets.UNITY_LICENSE }}
```

## Usage

### Editor Commands

```bash
# Open project in Unity Editor
ox unity open

# Execute editor script
ox unity exec --script Assets/Editor/BuildScript.cs --method BuildScript.BuildAll

# Run headless (no graphics)
ox unity batch --executeMethod BuildScript.BuildAll

# Import package
ox unity import-package com.unity.addressables

# Update packages
ox unity update-packages
```

### Build Automation

```bash
# Build for all platforms (development)
ox unity build --config development

# Build specific platform
ox unity build --platform WebGL --config release

# Build with custom output
ox unity build --platform Android --output ./builds/android/app.aab

# Build Addressables
ox unity build-addressables --config release

# Clean build artifacts
ox unity clean
```

### Testing

```bash
# Run EditMode tests
ox unity test --mode editmode

# Run PlayMode tests
ox unity test --mode playmode

# Run with coverage
ox unity test --coverage --output ./coverage

# Run specific test assembly
ox unity test --assembly Tests.Editor

# Generate Test Runner XML for CI
ox unity test --results ./test-results.xml
```

### Asset Management

```bash
# Validate assets
ox unity validate-assets

# Generate asset report
ox unity asset-report --output ./asset-report.json

# Build asset bundles
ox unity build-bundles --platform StandaloneWindows64

# Verify Addressables
ox unity verify-addressables
```

### Deployment

```bash
# Deploy to Unity Cloud Build
ox unity cloud-build --target development --platform iOS

# Export Xcode project (iOS)
ox unity export --platform iOS --output ./builds/ios

# Export Gradle project (Android)
ox unity export --platform Android --output ./builds/android

# Create WebGL deployment package
ox unity deploy-webgl --output ./dist --compress brotli
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/unity.yml
name: Unity Build & Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Unity
        uses: game-ci/unity-installer@v2
        with:
          unityVersion: 2022.3.20f1
          
      - name: Activate License
        uses: game-ci/unity-activate@v2
        env:
          UNITY_LICENSE: ${{ secrets.UNITY_LICENSE }}
          
      - name: Run Tests
        run: ox unity test --coverage
        
      - name: Upload Coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/cobertura.xml

  build:
    needs: test
    runs-on: ubuntu-latest
    strategy:
      matrix:
        platform: [WebGL, StandaloneLinux64, Android]
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Unity
        uses: game-ci/unity-installer@v2
        with:
          unityVersion: 2022.3.20f1
          
      - name: Build
        run: ox unity build --platform ${{ matrix.platform }} --config release
        
      - name: Upload Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-${{ matrix.platform }}
          path: builds/${{ matrix.platform }}/
```

### GitLab CI

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build

test:
  stage: test
  image: unityci/editor:2022.3.20f1-base-1
  script:
    - ox unity test --coverage
  coverage: '/Total coverage: (\d+\.\d+)%/'

build_webgl:
  stage: build
  image: unityci/editor:2022.3.20f1-webgl-1
  script:
    - ox unity build --platform WebGL --config release
  artifacts:
    paths:
      - builds/WebGL/
    expire_in: 1 week
```

## Platform-Specific Notes

### WebGL
```json
{
  "buildTargets": {
    "release": {
      "webgl": {
        "compression": "Brotli",
        "nameFilesAsHashes": true,
        "dataCaching": true,
        "wasmStreaming": true
      }
    }
  }
}
```

### Android
```bash
# Keystore for signing
ox unity build --platform Android \
  --keystore ./keystore.jks \
  --keystore-pass "${KEYSTORE_PASS}" \
  --key-alias "${KEY_ALIAS}" \
  --key-pass "${KEY_PASS}" \
  --output ./builds/app.aab
```

### iOS
```bash
# Requires macOS runner
ox unity build --platform iOS --config release

# Post-process for Xcode
ox unity postprocess-ios --project ./builds/ios \
  --team-id "${APPLE_TEAM_ID}" \
  --bundle-id "com.example.game"
```

## Limits & Constraints

| Constraint | Limit | Workaround |
|------------|-------|------------|
| Unity version | 2022.3+ | Use Docker images for older versions |
| Parallel builds | 1 per license | Multiple licenses for parallel CI |
| Build time | ~30-60 min | Cache Library/, use Unity Cache Server |
| IL2CPP compile | Single-threaded | Use faster machine, disable debug |
| WebGL memory | 2GB heap default | Configure in PlayerSettings |
| Addressables groups | 1000 | Use labels for organization |

## Troubleshooting

### License Activation Fails
```bash
# Check license format
echo $UNITY_LICENSE | base64 -d | head -5

# Manual activation
/Applications/Unity/Hub/Editor/2022.3.20f1/Unity.app/Contents/MacOS/Unity \
  -batchmode -nographics -logFile - \
  -username $UNITY_EMAIL -password $UNITY_PASSWORD
```

### Build Hangs
```bash
# Increase timeout
ox unity build --timeout 3600

# Check for deadlocks
ox unity build --verbose --log-file build.log
```

### Test Failures in CI
```bash
# Run with graphics (PlayMode)
ox unity test --mode playmode --graphics

# Specific Unity version
ox unity test --unity-version 6000.0.15f1
```

### Cache Server Issues
```bash
# Start local cache server
docker run -d -p 8125:8125 unitycache/server:latest

# Verify connection
ox unity cache-status
```

## Best Practices

1. **Pin Unity version** in `.ox/unity.json` and CI
2. **Use Cache Server** for team builds
3. **Separate test assemblies** for EditMode/PlayMode
4. **Addressables for content** - reduces build size
5. **IL2CPP for release** - better performance, smaller builds
6. **Strip engine code** - Managed Stripping Level: High

## Migration

### From Unity Cloud Build Config

```bash
# Export Cloud Build config
ox unity migrate-from-cloudbuild --project-id <id> --api-key <key>
```

### From Manual Build Scripts

```bash
# Auto-detect build scripts
ox unity detect-build-scripts --output .ox/unity.json
```
