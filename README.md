# technoline.ge — Site Content + Booking API (სატესტო სერვერი)

ეს არის მცირე, დამოუკიდებელი Node.js სერვერი, რომელიც technoline.ge-ს საიტს და ცალკე ადმინ პანელს
დაუკავშირდება, სანამ იგივე endpoint-ები Q-Logic-ის რეალურ სერვერზე დაემატება.

## გაშვება

```
cd qlogic-content-api
npm install
node server.js
```

ნაგულისხმევად გაეშვება `http://localhost:4001`-ზე. ადმინის პაროლი ნაგულისხმევად არის `technoline2026` —
შესაცვლელად გაუშვით ასე:

```
ADMIN_PASSWORD=თქვენი-პაროლი node server.js
```

მონაცემები ინახება `data.json` ფაილში (იქმნება ავტომატურად პირველ გაშვებაზე) — წაშლა/გასუფთავება
პირდაპირ ამ ფაილის წაშლით შეგიძლიათ.

## რატომ `localhost`-ზეც მუშაობს

claude.ai-ზე გამოქვეყნებული Artifact (საიტი და ადმინ პანელი) HTTPS-ზეა, მაგრამ ბრაუზერები
გამონაკლისს უშვებენ `http://localhost`-ისთვის — mixed-content არ ილუქება. ანუ სანამ ეს სერვერი
თქვენსავე კომპიუტერზე გაშვებულია და საიტს იმავე კომპიუტერის ბრაუზერიდან ხსნით, ინტეგრაცია
ისე იმუშავებს, თითქოს უკვე რეალურ დომენზეა.

## API კონტრაქტი

### საიტის კონტენტი

- `GET /api/site` → `{ content: {...}, theme: {...}, parts: {...}, branches: {...} }`
  ერთი გამოძახებით ყველა საიტის მონაცემი — ამას იყენებს თავად საიტი გახსნისას.
- `GET /api/site/:doc` → ცალკე დოკუმენტი, სადაც `:doc` არის `content-site` | `theme-site` | `content-parts` | `content-branches`
- `PUT /api/site/:doc` (საჭიროებს `Authorization: Bearer <token>`) → სხეულში სრული ობიექტი, რომელიც მთლიანად ჩაანაცვლებს დოკუმენტს (ისევე როგორც ძველი `db.doc(path).set(body)`)

დოკუმენტების შიგთავსის ფორმატი ზუსტად იმეორებს იმას, რაც CMS-ს ადრე ჰქონდა:
- `content-site`: `{ "home.hero.title": "<b>...</b>", "about.head.title": "...", ... }` — გასაღები არის `data-ck` ატრიბუტის მნიშვნელობა, მნიშვნელობა — HTML სტრიქონი.
- `theme-site`: `{ "gold": "#FCBB2D", "goldDeep": "#C98A08", "goldSoft": "#FFD788", "blue": "#0E4F8E", "blueDeep": "#0A3A69", "blueMid": "#5C86AE" }`
- `content-parts`: `{ "<partId>": { "name": "...", "price": 120, "stock": "in" }, ... }`
- `content-branches`: `{ "<branchId>": { "name": "...", "addr": "...", "hours": "...", "phone": "..." }, ... }`

### ავტორიზაცია (ადმინი)

- `POST /api/auth/login` სხეული `{ "password": "..." }` → `{ "token": "..." }` — ამ ტოკენს იყენებთ `Authorization: Bearer <token>` სათაურში ყველა `PUT`/დაცულ მოთხოვნაზე. ტოკენი 12 საათში იწურება.

### ჯავშნები

- `POST /api/bookings` სხეული `{ branchId, serviceType, date, timeSlot, name, phone, deviceType?, issue?, notes? }` → `201` პასუხად ბრუნდება `{ id, confirmationCode, status:"received", createdAt, ...იგივე ველები }`
- `GET /api/bookings/:id` → ერთი ჯავშნის სტატუსი
- `GET /api/bookings` (საჭიროებს `Authorization: Bearer <token>`) → ბოლო 200 ჯავშანი, სტაფისთვის

### საგარანტიო ბარათი (PDF / SMS / მეილი)

- `GET /api/warranty/:serial` → `{ serial, device, cat, purchase, end, active, remainingLabel }` ან `404 {error:"not_found"}`. მონაცემები ინახება `content/warranty`-ში (იგივე `readDb`/`writeDb` გზით, რაც `content/parts`-ს და `content/branches`-ს აქვს).
- `GET /api/warranty/:serial/card` → PDF ბარათი (`application/pdf`), გენერირებული სერვერზე `warranty-pdf.js`-ით — ქართული ტექსტისთვის `fonts/` ფოლდერში ჩადებულია Noto Sans Georgian (Georgian + Latin ორივე დაშვება, რადგან თარიღები/სერიული ნომრები ლათინურით იწერება).
- `POST /api/warranty/:serial/send` სხეული `{ method: "email"|"sms", destination }`:
  - `email`: გზავნის იმავე PDF-ს დანართად, `nodemailer`-ით. საჭიროებს Render-ის env cვლადებს: `SMTP_HOST`, `SMTP_PORT` (ნაგულისხმევი 587), `SMTP_USER`, `SMTP_PASS`, სურვილისამებრ `SMTP_SECURE=true` და `SMTP_FROM`. სანამ ეს ცვლადები არ არის დაყენებული, პასუხობს `503 {error:"not_configured"}`.
  - `sms`: განკუთვნილია Wifisher-ისთვის, მაგრამ მისი API-ის ფორმატი ჯერ არ არის ცნობილი — `sendWifisherSms()` ფუნქცია `server.js`-ში პლეისჰოლდერია, `WIFISHER_API_URL`/`WIFISHER_API_KEY` ცვლადები ჯერ ცარიელია და პასუხობს `503`-ს, სანამ არ შეივსება რეალური endpoint/ფორმატით.

## გადატანა რეალურ Q-Logic სერვერზე

როცა მზად იქნებით: ან (ა) ეს ზუსტად იგივე route-ები დაამატეთ Q-Logic-ის `server.js`-ში (`requireAuth`/`requireRole`-ით ჩაანაცვლეთ ამ ფაილის მარტივი token-auth), ან (ბ) მითხარით და დაგეხმარებით ინტეგრაციაში. ორივე შემთხვევაში, საიტსა და ადმინ პანელში მხოლოდ ერთი მუდმივის შეცვლა დაგჭირდებათ:

```js
const API_BASE = 'http://localhost:4001';   // →  'https://eticket.technoline.ge'
```
