# SmartSubsV2 KV Monitor — Fasa 2

## Pasang

Gantikan enam fail ZIP pada path asal projek. ZIP ini dibina di atas patch KV Usage Tracker sebelumnya, **bukan** di atas SmartSubsV2 versi asal.

Tidak perlu binding KV tambahan, secret tambahan atau migration Durable Object baharu. `SMARTSUBS_DELIVERY` Durable Object yang sudah dikonfigurasi digunakan melalui *instance berasingan bagi setiap token konfigurasi*. `wrangler.jsonc` sedia ada mesti masih mempunyai binding `SMARTSUBS_DELIVERY`.

Commit dan deploy Worker baharu ke Cloudflare. CI GitHub hijau sahaja belum mengaktifkan kod dalam Worker. Jika menggunakan GitHub workflow auto-unzip lama, ganti fail `.github/workflows/smartsubs-auto-apply-kv-patch.yml` dengan workflow monitor yang dibekalkan sebelum upload ZIP baharu. Kekalkan workflow CI sedia ada.

## Buka laporan di telefon

1. Salin URL addon **milik kau sendiri** yang dihasilkan oleh SmartSubsV2 (bentuk `/c/<token>/manifest.json`).
2. Dalam URL itu, gantikan `manifest.json` sahaja kepada `kv-monitor` lalu buka dalam pelayar. Contoh bentuk: `https://<worker>.workers.dev/c/<token>/kv-monitor`.
3. Buka dan main satu episod, tunggu sari kata selesai. Tekan **Muat semula** di halaman monitor. Ketik kad episod untuk lihat pecahan Cache, Diagnostik, Queue dan fasa permintaan.

Jangan kongsi URL sebenar atau token tersebut; ia token konfigurasi peribadi. Data dipisahkan mengikut token konfigurasi: jika generate token baharu, sejarah lama tidak muncul di token baharu.

## Apa yang diukur

- Jumlah operasi `get` / `put` / `list` / `delete` yang dipanggil oleh kod SmartSubsV2 untuk setiap filem atau episod, dikumpul merentas `subtitle-list`, `queue`, dan `player-translation`.
- Permintaan berulang dicampurkan dalam jumlah episod dan dikira sebagai `permintaan direkod`; paparan bukan kos satu sesi tontonan.
- Laporan mengandungi **tujuh hari kalendar termasuk hari ini**; ia bermula selepas Worker monitor ini dideploy, tiada import automatik daripada log lama.
- Laporan ditulis ke **Durable Object storage**, bukan Workers KV, jadi monitor tidak menambah operasi Workers KV. Durable Object tetap mempunyai had/kuota dan mungkin dikenakan caj bergantung pelan.
- Pengumpulan adalah best-effort: log Worker masih boleh digunakan untuk semak rekod yang gagal dikumpul. Dashboard bukan paparan kuota Cloudflare keseluruhan: operasi luar Worker, panggilan bypass tracker, atau operasi yang gagal dihantar ke monitor tidak termasuk. Bandingkan dengan Cloudflare Metrics untuk kiraan penggunaan sebenar.

Jangan padam `src/kv-usage.mjs` atau fail ujian lama. Kod Queue, terjemahan Gemini, cache dan diagnostik tidak diubah dalam patch monitor ini.
