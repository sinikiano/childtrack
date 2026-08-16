package com.childtrack.app.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface PointDao {
    @Query("SELECT * FROM points ORDER BY id ASC LIMIT :limit")
    suspend fun getOldest(limit: Int): List<PointEntity>

    @Query("SELECT COUNT(*) FROM points")
    suspend fun count(): Int

    @Insert
    suspend fun insert(point: PointEntity)

    @Insert
    suspend fun insertAll(points: List<PointEntity>)

    @Query("DELETE FROM points WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>)

    @Query("DELETE FROM points WHERE id IN (SELECT id FROM points ORDER BY id ASC LIMIT :n)")
    suspend fun dropOldest(n: Int)
}
