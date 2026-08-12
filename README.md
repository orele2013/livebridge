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

## Si se ve borroso

La cadena tiene cuatro puntos donde se pierde detalle. Por orden de impacto:

**1. El envío por WebRTC.** Es el cuello de botella habitual. Chromium, si no
se le dice lo contrario, trata la captura como vídeo en movimiento y sacrifica
resolución para sostener los fps: el texto se emborrona. LiveBridge marca la
pista como `contentHint = 'detail'`, fija `degradationPreference` en
`maintain-resolution` y sube el techo de bitrate a 16 Mbps por defecto — es red
local, no consume tu subida a internet.

En el emisor, para máxima nitidez: **Resolución máx.** en *Nativa*, **Techo de
envío** en *Máxima* si vais por cable, y **Priorizar nitidez (VP9)** marcado.
VP9 conserva el texto bastante mejor que VP8, que es lo que se negocia por
defecto. Si el equipo emisor va justo de CPU, desmárcalo para usar H.264.

**2. La resolución de la fuente.** Con el formato automático la salida copia la
forma y el tamaño de la fuente sin reescalar. Si el emisor envía a 1280×720 y
esperas 1080p, el detalle no existe: sube la resolución en el emisor.

**3. La ventana, si capturas desde LIVE Studio u OBS.** La vista limpia ajusta
la ventana para que **cada píxel del lienzo caiga en un píxel físico de
pantalla**, dividiendo por el factor de escala del monitor — en un Retina 2×,
un lienzo de 1920×1080 necesita una ventana de 960×540 puntos. Si la pantalla
no da para tanto, la consola avisa de a cuánto se está capturando realmente.

**4. La codificación final.** El puente interno hacia ffmpeg va a 20 Mbps o
más, para no recortar detalle antes de la codificación de verdad. En *Salida*,
el **Esfuerzo de codificación** cambia el preajuste de x264: *Máxima calidad*
aprovecha mejor cada bit a cambio de CPU. Y sube el **bitrate de vídeo** si tu
conexión aguanta: 8.000 kbps por defecto, y para texto pequeño a pantalla
completa 10.000–12.000 no sobran.

---

## Formato automático

Es el modo por defecto. En vez de encajar la fuente dentro de un formato fijo
—lo que deja franjas negras o recorta—, **la salida adopta la forma exacta de
la fuente**: si compartes una pantalla 16:9, el directo sale horizontal; si es
vertical, sale vertical. Ni bandas ni recorte, y ningún píxel del fotograma
codificado se desperdicia en negro.

La resolución se limita a caber en 1920×1080 (en la orientación que toque) y
**nunca se escala hacia arriba**, para no gastar bitrate inventando píxeles:

| Fuente | Salida |
|--------|--------|
| 1920×1080 | 1920×1080 |
| 3840×2160 | 1920×1080 |
| 1280×800 | 1280×800 |
| 1600×1200 | 1440×1080 |
| 1080×1920 | 1080×1920 |

El ajuste se aplica solo al cambiar de fuente, no en mitad de una emisión: si
la resolución cambia con el directo en marcha se avisa y se aplica al
reiniciarlo, porque cambiar el tamaño del fotograma sobre la marcha rompería
la señal.

Si prefieres forzar el vertical de TikTok aunque la fuente sea horizontal,
elige un formato fijo en *Salida* y usa *Encaje* para decidir entre franjas
(«Completo») o recorte («Rellenar»).

---

## Ajustes recomendados

| Formato | Bitrate vídeo | Notas |
|---------|---------------|-------|
| Automático | Según resolución | Sin franjas; sigue la orientación de la fuente |
| 1080×1920 @30 | 5.000–6.000 kbps | Lo estándar en TikTok |
| 720×1280 @30 | 2.500–3.500 kbps | Si la CPU va justa o la subida es lenta |
| 1920×1080 @30 | 4.500–6.000 kbps | Directos horizontales |

Si el indicador de velocidad de ffmpeg baja de `1.00x`, la máquina no llega:
baja la resolución o el bitrate.
