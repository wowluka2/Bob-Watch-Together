# Oglądamy razem

1. Zainstaluj Node.js (https://nodejs.org, wersja 16 lub nowsza).
2. Wrzuć filmy do folderu `videos` (najlepiej .mp4, wideo H.264 + dźwięk AAC).
   Napisy: plik o tej samej nazwie z rozszerzeniem .srt lub .vtt (np. `film.mp4` + `film.srt`).
3. Uruchom w tym folderze:  `node server.js`
4. Ty otwierasz `http://localhost:3000`.
5. Znajomy, połączony z Tobą przez Tailscale lub Radmin VPN, otwiera `http://TWÓJ_ADRES_VPN:3000`
   (adres wypisze serwer w konsoli; Tailscale: 100.x.x.x, Radmin: 26.x.x.x).

Inny folder lub port:  `VIDEO_DIR=D:\Filmy PORT=8080 node server.js`
(w PowerShell: `$env:VIDEO_DIR="D:\Filmy"; node server.js`)

Jeśli Windows zapyta o zaporę, zezwól Node.js w sieci prywatnej.
