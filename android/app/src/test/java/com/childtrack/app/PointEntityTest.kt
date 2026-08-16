package com.childtrack.app

import com.childtrack.app.db.PointEntity
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PointEntityTest {

    @Test
    fun toJson_includes_populated_fields() {
        val e = PointEntity(
            ts = 1700000000000L,
            lat = 52.520008,
            lon = 13.404954,
            accuracy = 5f,
            altitude = 34.2,
            speed = 2.5f,
            bearing = 90f,
            battery = 88,
        )
        val o: JSONObject = e.toJson()
        assertEquals(1700000000000L, o.getLong("ts"))
        assertEquals(52.520008, o.getDouble("lat"), 0.0)
        assertEquals(13.404954, o.getDouble("lon"), 0.0)
        assertEquals(5f, o.getFloat("accuracy"), 0f)
        assertEquals(34.2, o.getDouble("altitude"), 0.0)
        assertEquals(2.5f, o.getFloat("speed"), 0f)
        assertEquals(90f, o.getFloat("bearing"), 0f)
        assertEquals(88, o.getInt("battery"))
    }

    @Test
    fun toJson_omits_null_fields() {
        val e = PointEntity(ts = 1L, lat = 0.0, lon = 0.0)
        val o = e.toJson()
        assertFalse(o.has("accuracy"))
        assertFalse(o.has("altitude"))
        assertFalse(o.has("speed"))
        assertFalse(o.has("bearing"))
        assertFalse(o.has("battery"))
        assertEquals(1L, o.getLong("ts"))
        assertTrue(o.has("lat"))
        assertTrue(o.has("lon"))
    }
}
