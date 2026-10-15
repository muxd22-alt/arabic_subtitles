import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Signing material for release builds. Never committed: CI writes it from the
// KEYSTORE_* secrets, or you point keystore.properties at your own .jks locally.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) {
        keystorePropsFile.inputStream().use { load(it) }
    }
}
fun secret(key: String, env: String): String? =
    keystoreProps.getProperty(key) ?: System.getenv(env)?.takeIf { it.isNotBlank() }

// Names are deliberately distinct from the SigningConfig property names: inside
// create("release") { } a bare `storePassword = storePassword` would resolve both
// sides to the (still-null) SigningConfig property, silently dropping the secret.
val ksStoreFile = secret("storeFile", "KEYSTORE_FILE")
val ksStorePassword = secret("storePassword", "KEYSTORE_PASSWORD")
val ksKeyAlias = secret("keyAlias", "KEY_ALIAS")
val ksKeyPassword = secret("keyPassword", "KEY_PASSWORD")

// keystore.properties lives at the repo root, so a relative storeFile (e.g.
// ".signing/release.jks") must resolve against the root, not the app module.
val hasKeystore = ksStoreFile != null && ksStorePassword != null && ksKeyAlias != null && ksKeyPassword != null

android {
    namespace = "com.arabicsubs"
    compileSdk = 35

    signingConfigs {
        if (hasKeystore) {
            create("release") {
                storeFile = rootProject.file(ksStoreFile!!)
                storePassword = ksStorePassword
                keyAlias = ksKeyAlias
                keyPassword = ksKeyPassword
            }
        }
    }

    defaultConfig {
        applicationId = "com.arabicsubs"
        minSdk = 26
        targetSdk = 35
        versionCode = 13
        versionName = "2.2"

        ndk {
            abiFilters += setOf("arm64-v8a")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = libs.versions.composeCompiler.get()
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // A release signed with an ephemeral debug key installs once and
            // then refuses every later update ("signed with a different key").
            // CI passes the real key in via keystore.properties / env.
            // same condition as signingConfigs above: if a keystore is
            // available we MUST sign with it, otherwise every release is
            // signed with a throwaway debug key and no update ever installs
            signingConfig = signingConfigs.getByName(if (hasKeystore) "release" else "debug")
        }
    }
}

dependencies {
    // Compose BOM
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.navigation.compose)
    implementation(libs.core.ktx)
    debugImplementation(libs.compose.ui.tooling)

    // AndroidX Storage & DocumentFile for SAF directory traversal
    implementation("androidx.documentfile:documentfile:1.0.1")
}
