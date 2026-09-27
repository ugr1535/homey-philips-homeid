# Philips HomeID: Home Assistant / Homey karşılaştırması (25.09.2026)

Karşılaştırma kaynağı: `renaudallard/homeassistant_philips_homeid`, commit
`dd2696261d8f8b52d4fb063c3809530e705c23ec` (3.9.8). Bu rapor kod
karşılaştırmasıdır; tüm cihaz modellerinin fiziksel doğrulaması değildir.

| Alan | Home Assistant | Homey 0.1.28 |
| --- | --- | --- |
| Airfryer / multicooker temel güç, pişirme, durdurma, sıcaklık, süre, ön ısıtma | Var | Var |
| SPECTRE, Venus, Nutrimax, Hermes program kodları | Modele özgü | Modele özgü menü ve geçersiz kod engeli eklendi |
| Prob hedefi, mevcut prob sıcaklığı, hava hızı | Var | Cihaz bildirdiğinde görünür; hedef ve hava hızı yazılabilir |
| Tarif, aşama, hata, çevirme/prob/çekmece uyarıları; çift hazne | Var | Cihaz bildirdiğinde otomatik eklenen sensörler |
| Venus AutoCook durum alanları | Var | UUID, pişme, miktar/ağırlık/kalınlık okunur |
| Airfryer My Presets ve AutoCook katalog seçimi | Var | Henüz yok; bulut kataloğu, cihaz eşleme ve modele özgü komut doğrulaması gerektiriyor |
| Hava temizleyici güç/mod/çocuk kilidi/PM2.5/AQI/filtre | Var | Var |
| PM1, PM10, TVOC, alerjen; ayrı filtre ömrü ve kalan saatler; su seviyesi | Var | Bildirilen alanlar dinamik eklenir |
| MUJI bip seviyesi, hava kalitesi eşiği, bekleme sensörü | Var | Bildirilen alanlar dinamik eklenir ve Control portuna yazılır |
| Espresso Rita profil, çekirdek/kavurma, içecek ve kayıtlı tarif, iptal/devam/adım atla | Var | Var |
| FUSION BasicRecipe doz ve hazırlama ayarları | Var | Port bildirildiğinde beş ayar dinamik eklenir |
| Yerel espresso BasicRecipe doz/sıcaklık/çoklu hazırlama sayı ayarları | Var | Henüz yok; mevcut Homey hazırlama komutları sabit reçete alanları kullanıyor |
| Bulut tarif adlarını API'den çözümleme | Var | Cihaz bildirirse gösterilir; dış katalog çözümlemesi henüz yok |
| FUSION aktif durum yoklaması | 20 saniye | 20 saniye; boşta 300 saniye |
| Bağlantı kopması / ilk bağlantı hatası | Geri deneme | Üstel gecikmeli geri deneme ve cihazı erişilemez gösterme |

## Kaynak ve hata denetimi

- FUSION mesajları 100 ms penceresinde birleştiriliyor; eski durum işlemesi
  sürüyorsa yalnızca en yeni durum bekletiliyor. Port-okuma zamanlayıcısı ve
  bağlantı kopunca kalan iş kuyruğu temizleniyor.
- Yerel firmware sorgusu başarılıysa saatte bir, hata aldıysa en erken 5 dakika
  sonra yeniden deneniyor. HTTP yanıtı 8 MiB üstünde bellek korumasıyla kesiliyor.
- Yerel, GC sonrası sentetik denemede 100.000 durum mesajı 10 güncellemeye
  indirildi; 10 turda heap 6.59–6.62 MiB aralığında kaldı. Bu Homey cihazının
  tüm uygulama RSS/CPU değeri değildir.
- Gerçek Homey CPU/RAM, MQTT kopması ve tüm model kontrolleri cihaz üzerinde
  profil ve fiziksel test gerektirir.
