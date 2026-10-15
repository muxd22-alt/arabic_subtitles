package com.arabicsubs.ui.theme

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * A 4dp-based spacing scale. The layout used to reach for whatever number
 * looked right (6, 8, 10, 12, 14, 16dp all appeared), which is how spacing
 * drifts. Every gap in the app now comes from here.
 *
 * Rhythm: tight inside a group, generous between groups, and always more room
 * above a heading than below it.
 */
object Space {
    /** hairline gap inside a single element */
    val xxs: Dp = 2.dp
    /** inside a control: icon to its label */
    val xs: Dp = 4.dp
    /** between siblings in a tight group (e.g. a row of buttons) */
    val sm: Dp = 8.dp
    /** default gap between elements */
    val md: Dp = 12.dp
    /** between groups */
    val lg: Dp = 16.dp
    /** above a heading, and between major sections */
    val xl: Dp = 24.dp
    /** screen edge padding */
    val screen: Dp = 20.dp

    /** Material's minimum interactive size — nothing tappable goes below this. */
    val touch: Dp = 48.dp
}