# SmartSubsV2 — KV Usage Tracker (Fasa 1: pengukuran sahaja)

## Pasang patch

Salin fail dan folder di dalam ZIP ke akar repository SmartSubsV2, ikut path asal. Gantikan fail yang sama namanya. ZIP menyertakan `src/translator.js` dengan prompt TV baharu, supaya prompt yang sedang digunakan tidak ditimpa oleh versi lama. Tidak perlu menambah atau memadam GitHub Actions workflow.

Jalankan `npm run check` dan `npm test`, kemudian **deploy Worker** (contohnya `npx wrangler deploy`, menggunakan konfigurasi/akses Cloudflare sendiri). CI GitHub sahaja tidak mengaktifkan kod Worker di Cloudflare.

`wrangler.jsonc` menambah `observability.enabled: true` dan `head_sampling_rate: 1` untuk merekodkan setiap invocation; jika diubah kepada sampling lebih rendah, laporan tidak lengkap. Tetapan lain dan KV namespace dikekalkan.

## Dapatkan bacaan

1. Cloudflare Dashboard > Workers & Pages > `smartsubsv2` > **Observability** > Logs (atau **Logs > Live** untuk rekod langsung).
2. Buka episod/filem melalui SmartSubsV2 selepas versi baharu sudah dideploy.
3. Cari teks `SMARTSUBS_KV_USAGE`. Rekod dihasilkan untuk setiap request HTTP, dan **setiap percubaan queue** mempunyai rekod berasingan.
4. Untuk episod baharu, baca laporan `subtitle-list`, `player-translation` dan `queue` bagi `media.id` yang sama. Permintaan berulang akan muncul sebagai rekod tambahan, bukannya menimpa yang lama. `media.type=series` serta `season` dan `episode` membezakan episod; `movie` untuk filem.
5. Opsyenal: salin **hanya objek JSON SMARTSUBS_KV_USAGE** (sebaris setiap satu) ke `kv-logs.jsonl`, kemudian jalankan `node scripts/kv-usage-report.mjs kv-logs.jsonl` untuk menjumlahkan bacaan mengikut media.

**Contoh bentuk rekod (angka bukan keputusan penggunaan sebenar):**

```json
{"tag":"SMARTSUBS_KV_USAGE","phase":"player-translation","media":{"type":"series","id":"tt123:1:6","season":1,"episode":6},"attempted":{"get":2,"put":2,"list":0,"delete":0},"failed":{"get":0,"put":0,"list":0,"delete":0},"categories":{"diagnostics":{"get":0,"put":2,"list":0,"delete":0}}}
```

`get` = Read, `put` = Write, `list` = List, `delete` = Delete. `attempted` = panggilan API daripada kod; `succeeded` = panggilan yang selesai; `failed` = panggilan yang melempar ralat (termasuk 429). Pecahan `categories` ialah **attempted**, bukan anggaran. `cacheResult` menunjukkan HIT/MISS/DELIVERY_RELAY apabila dikenali. Bagi cache memori, `get` KV boleh menjadi 0. Tiada data KV tambahan disimpan oleh tracker.

**Had ketepatan:** Kita dapat kira panggilan API KV oleh Worker bagi invocation yang direkodkan; Cloudflare menentukan operasi yang dibil dan had akaun, jadi bandingkan dengan Cloudflare KV Metrics. Akses KV dari Dashboard, Wrangler atau Worker lain tidak boleh dikaitkan dengan cerita melalui tracker ini. Log yang disampel/hilang tidak boleh dijumlahkan secara lengkap. Terjemahan lama melalui pautan token *sebelum patch* tidak mempunyai metadata filem/episod dan dilabel `mediaKnown:false`; buka semula senarai sari kata selepas deploy untuk mendapatkan pautan baharu, tanpa membuang cache terjemahan lama. `media.id` ialah ID Stremio, bukan tajuk cerita; `season`/`episode` dibaca daripada ID berturutan `:season:episode` apabila ada.

Tracker tidak merekod API key, URL sari kata, token akses, teks sari kata, key KV, atau kandungan KV. Ia tidak mengubah penyimpanan diagnostik, queue, cache versi, dan prompt Gemini. Logs Cloudflare ialah saluran pengukuran dan mempunyai retensi/kuota tersendiri, berasingan daripada Workers KV.
