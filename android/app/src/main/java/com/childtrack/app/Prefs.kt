package com.childtrack.app

import android.content.Context

object Prefs {
    private const val NAME = "childtrack"
    const val KEY_SERVER  = "server"
    const val KEY_TOKEN   = "token"
    const val KEY_PERIOD  = "period_sec"
    const val KEY_RUNNING = "running"
    const val KEY_PIN_HASH = "pin_hash"

    fun get(ctx: Context) = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)
}
