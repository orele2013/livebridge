# LiveBridge

Aplicación de escritorio (macOS, Windows y Ubuntu) para emitir a **TikTok LIVE**
—o a cualquier destino RTMP— desde tu ordenador, **mostrando la pantalla de otro
equipo**.

Una sola aplicación con dos modos:

| Modo | Dónde se instala | Qué hace |
|------|------------------|----------|
| **Estudio** | El ordenador que tiene tu cuenta de TikTok | Compone la escena (pantalla remota + tu cámara + audio) y emite por RTMP |
| **Emisor** | El otro ordenador | Manda su pantalla al Estudio por la red local, vía WebRTC |

Si prefieres no instalar nada en el segundo equipo, el Estudio también acepta
una **capturadora HDMI/USB** (aparece como un dispositivo de vídeo más) o la
pantalla del propio equipo.

---

## Requisitos de TikTok

- **1.000 seguidores** y +18 años para poder hacer LIVE.
- La **URL del servidor** y la **clave de retransmisión** se obtienen en
  <https://livecenter.tiktok.com> o en TikTok LIVE Studio. Se pegan en
  *Destino* dentro del Estudio.

Sin esos dos datos puedes usar el modo **«Solo grabar a MP4»** para probar todo
el montaje sin emitir.

---

## Instalación desde el código

```bash
npm install
npm start
```

Compilar instaladores (cada sistema se compila en su propia máquina):

```bash
npm run dist:mac     # .dmg + .zip
npm run dist:win     # .exe (NSIS) + portable
npm run dist:linux   # .AppImage + .deb
```

El workflow de GitHub Actions (`.github/workflows/build.yml`) compila los tres
al publicar una etiqueta `v*`.

---

## Cómo se usa

### En el ordenador que emite (Estudio)

1. Abre LiveBridge → **Estudio**.
2. En *Fuente principal* deja **«Pantalla de otro ordenador»**. Verás la **IP**,
   el **puerto** y un **código de 6 dígitos**.
3. Rellena *Destino* con la URL y la clave de TikTok.
4. Ajusta el formato (por defecto **1080×1920**, el vertical de TikTok).
5. Cuando el emisor conecte, verás su pantalla en la vista previa.
6. **Iniciar emisión** y, en el panel de TikTok, **Go LIVE**.

### En el otro ordenador (Emisor)

1. Abre LiveBridge → **Emisor**.
2. Elige la pantalla o ventana que quieres compartir.
3. Escribe la IP, el puerto y el código del Estudio → **Conectar y emitir**.

---

## Vista limpia (para TikTok LIVE Studio u OBS)

Si tu cuenta no tiene permiso para emitir por RTMP —el permiso de LIVE en el
móvil y el de escritorio son distintos—, puedes usar LiveBridge solo como
mezclador y que sea LIVE Studio quien emita.

Pulsa **Vista limpia** en la barra superior (o doble clic sobre la vista
previa). La interfaz desaparece, queda únicamente la imagen compuesta y la
ventana se ajusta a la proporción de salida, de modo que al capturarla desde
otro programa recoges exactamente la composición, sin bordes ni controles.

Luego, en LIVE Studio, añade una fuente de **captura de ventana** apuntando a
LiveBridge.

Se sale con **Esc** o con el botón flotante, que se desvanece a los 2,5
segundos para no aparecer en la captura. Se puede entrar y salir en mitad de
una emisión: no afecta a la señal.

Ten en cuenta que por esta vía la imagen se comprime dos veces, así que el
texto pequeño pierde algo de nitidez frente a la emisión directa por RTMP.

---

## Detalles técnicos

- **Transporte entre equipos**: WebRTC punto a punto, con un WebSocket propio
  solo para la señalización. No pasa por ningún servidor externo: todo se queda
  en tu red local.
- **Composición**: la escena se dibuja en un `<canvas>` a la resolución de
  salida (pantalla ajustada + cámara en PIP con forma redonda o rectangular).
- **Codificación**: `MediaRecorder` → `ffmpeg` (incluido en la app) →
  H.264 `yuv420p` + AAC, keyframe cada 2 s, CBR con `-maxrate`/`-bufsize`.
  Son los parámetros que pide TikTok.
- **Reintento automático**: si ffmpeg se cae (corte de red), la emisión se
  reinicia sola hasta 5 veces.

---

## Permisos por sistema

**macOS** — La primera vez hay que autorizar *Grabación de pantalla* en
Ajustes del Sistema › Privacidad y seguridad, y **reiniciar la app**. macOS no
permite capturar el audio interno: para enviarlo instala
[BlackHole](https://existential.audio/blackhole/) y selecciónalo como salida.

**Windows** — El audio del sistema se captura sin nada extra.

**Ubuntu** — En Wayland la captura va por el portal de PipeWire: el sistema
mostrará su propio selector de pantalla al conectar. El audio depende de
PulseAudio/PipeWire; si falla, el vídeo se envía igualmente.

---

## Pruebas

```bash
npm test        # tubería ffmpeg completa (WebM -> MP4 H.264/AAC), sin interfaz
npm run selftest  # graba 6 s del compositor real y cierra la app
```

---

## Ajustes recomendados

| Formato | Bitrate vídeo | Notas |
|---------|---------------|-------|
| 1080×1920 @30 | 5.000–6.000 kbps | Lo estándar en TikTok |
| 720×1280 @30 | 2.500–3.500 kbps | Si la CPU va justa o la subida es lenta |
| 1920×1080 @30 | 4.500–6.000 kbps | Directos horizontales |

Si el indicador de velocidad de ffmpeg baja de `1.00x`, la máquina no llega:
baja la resolución o el bitrate.
