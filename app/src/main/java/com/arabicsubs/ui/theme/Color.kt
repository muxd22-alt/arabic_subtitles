package com.arabicsubs.ui.theme

import androidx.compose.ui.graphics.Color

// ── Primary palette: violet / indigo dusk ──
// Two accent roles, because one colour cannot serve both jobs at AA:
//   Accent     = the FILL (buttons, progress). DarkBg text on it = 4.87:1.
//   AccentText = the INK  (accent-coloured text and icons on dark surfaces),
//                lifted to 5.61:1 on the lightest card, 7.20:1 on the bg.
val Violet200 = Color(0xFFC4B5FD) // light violet ink on primaryContainer
val Violet300 = Color(0xFFA78BFA)
val Violet400 = Color(0xFF8B7CF6)
val Violet500 = Color(0xFF7C6BF0) // fill only
val Violet600 = Color(0xFF6A57E0)
val Violet700 = Color(0xFF5745C4)

// ── Dark surface system (every text token clears 4.5:1 on all four) ──
val DarkBg       = Color(0xFF0B0B14)
val DarkSurface  = Color(0xFF121220)
val DarkCard     = Color(0xFF1B1A2E)
val DarkCardHigh = Color(0xFF232241)
val DarkBorder   = Color(0xFF2E2C4A)

// ── Semantic ──
val SuccessGreen = Color(0xFF34D399) // 10.19:1 on DarkBg
val InfoCyan     = Color(0xFF38BDF8) //  9.14:1 on DarkBg
val WarnAmber    = Color(0xFFFBBF24) // 11.73:1 on DarkBg
val ErrorRose    = Color(0xFFFB7185) //  7.28:1 on DarkBg

// ── Text ──
// 16.50 / 9.12 / 6.31 : 1 on DarkBg. TextMuted is violet-tinted, never gray.
val TextPrimary   = Color(0xFFEDE9FE)
val TextSecondary = Color(0xFFA5B0D6)
val TextMuted     = Color(0xFF8A90B8)

// The two accent roles, named for what they do.
val Accent     = Violet500
val AccentText = Violet300

// Back-compat aliases for call sites that still use the old names.
val Gold500 = Accent
val Gold700 = Violet700
val Gold50  = Violet300