# SmartSubsV2 KV Monitor — sesi ujian manual

Patch ini **dibina di atas** SmartSubsV2 KV Monitor sedia ada. Ia menambah pengukuran sesi ujian berasingan tanpa mengubah Gemini, cache, diagnostik, atau queue.

## Pasang melalui workflow auto-unzip

1. Letakkan fail `smartsubs-auto-apply-kv-session.yml` yang dibekalkan pada path **`.github/workflows/smartsubs-auto-apply-kv-patch.yml`** dalam branch `main`, menggantikan workflow auto-unzip lama. **Jangan ubah nama workflow** `SmartSubsV2 - Auto Apply KV Patch`: SmartSubsV2 CI sedia ada menggunakan nama itu sebagai trigger `workflow_run`.
2. Upload `SmartSubsV2_KV_Session_Monitor_Patch.zip` ke **root repository** dan commit. Jangan unzip manual jika guna workflow.
3. Workflow akan sahkan senarai/path ZIP, unzip, `npm run check`, `npm test`, kemudian **commit fail diekstrak dan padam ZIP hanya selepas ujian lulus**. CI seterusnya boleh berjalan melalui `workflow_run` sedia ada.
4. Pastikan Worker versi terbaru **dideploy ke Cloudflare**. GitHub Actions hijau tidak semestinya bererti Worker sudah dideploy.

## Cara ukur menggunakan telefon

Buka pautan konfigurasi SmartSubsV2 milik sendiri yang berakhir dengan `/kv-monitor`. Jangan kongsi URL bertoken itu.

- Untuk **episod yang sudah ada dalam monitor**: buka kad episod, tekan **Mula ujian baharu**, kemudian buka semula episod dalam VUEO. Lakukan seek jika mahu menguji kesannya.
- Untuk **episod yang belum ada dalam monitor**: gunakan borang **Ujian episod baharu** dan masukkan `type` + ID contoh `tt1196946:2:3`, kemudian tekan **Mula ujian** *sebelum* membuka episod.
- Selepas sari kata siap, tunggu beberapa saat supaya rekod latar belakang sempat dihantar, kembali ke monitor, tekan **Tamatkan ujian**, kemudian **Muat semula**. Paparan sesi terkini berasingan daripada **Jumlah episod (semua ujian)**.
- **Reset laporan ujian** memerlukan checkbox pengesahan. Reset memadam **hanya rekod ujian manual bagi episod dipilih**, bukan jumlah episod 7 hari, cache terjemahan, queue atau diagnostik.
- Ujian aktif tamat automatik selepas **4 jam**; satu sesi ujian terkini disimpan bagi setiap episod. Bermula ujian baharu menggantikan rekod ujian sebelumnya untuk episod itu.

## Had bacaan

Sesi ini ialah **tetingkap ukuran yang dimulakan secara manual**, bukan pengesanan sesi player yang automatik. Semua request yang siap dan dihantar ketika ujian aktif untuk ID episod yang sama dimasukkan, termasuk akibat seek dan request serentak daripada peranti lain. Permintaan yang baru selesai selepas tekan Tamat mungkin tidak masuk sesi. Jumlah episod tetap dikumpul untuk tujuh hari kalendar termasuk hari ini.

Tracker tidak membuat Workers KV tambahan untuk laporan; ia menggunakan storan Durable Object yang mempunyai penggunaan/kuota tersendiri. Statistik ini bukan bil kuota Cloudflare: ia meliputi operasi KV yang melalui tracker dan berjaya dihantar ke monitor sahaja. Banding dengan Cloudflare Metrics bila perlu.
