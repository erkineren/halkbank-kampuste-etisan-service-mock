# Halkbank Kampüste — Etisan Service Mock

Halkbank Kampüste **Etisan Service** için minimum bağımlılıklı, Express tabanlı mock server. Gerçek serviste hangi route, request body ve response schema kullanılıyorsa burada da aynısı kullanılır — **sadece host değişir**.

Faz 1 olarak yalnız **rezervasyon** akışı kapsanmıştır:

| Endpoint | İstek modeli | Cevap modeli |
| --- | --- | --- |
| `POST /api/EtisanSistem/REZERVASYONLAR` | `GET_PARAM` (`TCKN`, `KART_ID`) | `RET_REZERVASYON_LISTESI` |
| `POST /api/EtisanSistem/REZERVASYON_EKLE` | `REZERVASYON_EKLE` | `RET_REZERVASYON` |
| `POST /api/EtisanSistem/REZERVASYON_IPTAL` | `REZERVASYON_IPTAL` | `RET_REZERVASYON` |
| `POST /api/EtisanSistem/YEMEKHANELER` | `GET_PARAM` (`TCKN`, `KART_ID`) | `RET_YEMEKHANELER` |

Hem `application/json` hem `application/x-www-form-urlencoded` body kabul edilir.

## API Docs

| URL | Açıklama |
| --- | --- |
| `/docs` | Swagger UI (Try it out destekli) |
| `/openapi.json` | OpenAPI 3.0 JSON spec |
| `/openapi.yaml` | OpenAPI 3.0 YAML spec |

Deploy: <https://hbk-etisan-mock.etisan.dev/docs>

## Çalıştırma

### Yerel (Node 18+)

```bash
npm install
npm start              # PORT=3000, STATEFUL=true
npm run dev            # node --watch
```

### Docker

```bash
docker build -t halkbank-kampuste-etisan-service-mock .
docker run --rm -p 3000:3000 halkbank-kampuste-etisan-service-mock
```

### Docker Compose

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

`PORT` ve `STATEFUL` ortam değişkenlerini override edebilirsiniz:

```bash
PORT=8080 STATEFUL=false docker compose up -d --build
```

## Davranış (Stateful)

`STATEFUL=true` (default) iken `(TCKN, KART_ID)` çiftine göre in-memory bir state tutulur:

- `REZERVASYONLAR` ilk çağrıldığında, default fixture (`data/rezervasyonlar.default.json`) klonlanır.
- `REZERVASYON_EKLE` çağrıldığında, `EKLEME_CONFIG.SEMA_ID + PERIYOT + GELEN_GUN` üçlüsü ile eşleşen menü öğesi şöyle güncellenir (gerçek service çıktısıyla bire bir):
  - `REZERVASYONU_VARMI = 1`
  - `IPTAL_CONFIG = { PERIYOT, ONAY_KODU (6 haneli numerik), KART_MIFARE_NO, LOKASYON }`
  - `EKLEME_CONFIG = { PERIYOT:"", AMOUNT:0.0, SEMA_ID:"", LOKASYON:<yemekhane adı>, KART_MIFARE_NO:"", GELEN_GUN:"0001-01-01T00:00:00" }` (.NET default)
  - `REZERVASYON_UYARI_METIN_SUB = <kurum deadline mesajı>`
  - `LOKASYON` istekteki `YEMEKHANE_ID`'ye karşılık gelen yemekhane adından çekilir (yemekhaneler.default.json üzerinden).
- `REZERVASYON_IPTAL` çağrıldığında, `IPTAL_CONFIG.ONAY_KODU` ile eşleşen menü öğesi default'a geri çevrilir.
- IPTAL response'u `_config.rezIptalSuccessReturnCode` / `rezIptalSuccessReturnDescription` ile yapılandırılır (Pamukkale'de gözlemlenen `RETURN_CODE=0, "İşlem Başarılı"` davranışı default).

`STATEFUL=false` ise her `REZERVASYONLAR` çağrısı default fixture'u döner; `EKLE`/`IPTAL` her zaman success döner ama liste değişmez.

## Mock-only yardımcı endpointler

| Endpoint | Açıklama |
| --- | --- |
| `GET  /health` | Healthcheck. |
| `GET  /__mock/state` | Tüm in-memory state'i JSON olarak döner. |
| `POST /__mock/reset` | Tüm in-memory state'i temizler. |

Bu endpointler gerçek serviste **yoktur**, sadece mock'a özeldir.

## Fixture'ı değiştirme

Default rezervasyon listesi `data/rezervasyonlar.default.json`, yemekhane listesi `data/yemekhaneler.default.json` içindedir. Postman'den / gerçek servisten aldığınız çıktıyı bu dosyalara kopyalayıp container'ı restart etmeniz yeterli.

`rezervasyonlar.default.json` dosyasının başında `_config` bloğu vardır — kurum-spesifik mesajları (EKLE success message, deadline message, IPTAL response code/description) buradan değiştirebilirsiniz.

Container'a fixture'ı dışarıdan mount etmek isterseniz:

```yaml
services:
  etisan-mock:
    volumes:
      - ./data/rezervasyonlar.default.json:/app/data/rezervasyonlar.default.json:ro
```

## Yapılacaklar (sonraki fazlar)

- Bütün diğer Etisan endpointleri (KULLANICI_*, KARTLAR, AKADEMIK, FIRSATLAR, ATM, Mobilet, Halk Akademi, Kampüs Giriş QR vb.)
- Senaryo bazlı response (`?scenario=success|fail|timeout`)
- Persistent state (file/Redis) — şu an sadece process-level memory.
