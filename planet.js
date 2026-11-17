const classicSeedKey = 'dot-by-qca-planet-seed'
const settingsKey = 'dot-by-qca-planet-settings'
const maxSeed = 0xffffffff
const fullCircle = 2 * Math.PI
const textures = ['bands', 'swirls', 'craters']
const colors = ['#49a996', '#678fd2', '#a884bd', '#d8956c', '#87a363', '#ca7f97', '#589faf', '#b8a263']
const switches = ['ring', 'glint', 'moon', 'motion']

function isSeed(value) {
  return Number.isInteger(value) && value >= 0 && value <= maxSeed
}

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

function readStored(key) {
  try { return localStorage.getItem(key) } catch { return null }
}

function store(key, value) {
  try { localStorage.setItem(key, value) } catch {}
}

function seededRandom(seed) {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export function planetPreset(seed) {
  const random = seededRandom(seed)
  return {
    seed,
    color: colors[Math.floor(random() * colors.length)],
    texture: textures[Math.floor(random() * textures.length)],
    shadow: Math.round(34 + random() * 45),
    ring: random() < 0.65,
    glint: random() < 0.55,
    moon: random() < 0.65,
    motion: false,
  }
}

function loadSettings(classicSeed) {
  let saved
  try { saved = JSON.parse(readStored(settingsKey)) } catch {}
  const preset = planetPreset(isSeed(saved?.seed) ? saved.seed : classicSeed)
  const options = {
    ...preset,
    mode: saved?.mode === 'generated' ? 'generated' : 'classic',
    color: typeof saved?.color === 'string' && /^#[\da-f]{6}$/i.test(saved.color) ? saved.color : preset.color,
    texture: textures.includes(saved?.texture) ? saved.texture : preset.texture,
    shadow: Number.isFinite(saved?.shadow) && saved.shadow >= 0 && saved.shadow <= 100 ? saved.shadow : preset.shadow,
  }
  for (const key of switches) {
    if (typeof saved?.[key] === 'boolean') options[key] = saved[key]
  }
  return options
}

function styleClassic(images, seed) {
  const hue = (seed & 0xffff) / 0x10000 * 360
  const tilt = ((seed >>> 16) & 0xff) / 255 * 120 - 60
  const flip = (seed & 0x01000000) ? -1 : 1
  const saturation = 0.7 + (seed >>> 25) / 127 * 0.3
  for (const image of images) {
    image.style.filter = `hue-rotate(${hue}deg) saturate(${saturation})`
    image.style.transform = `rotate(${tilt}deg) scaleX(${flip})`
  }
}

function geometry(seed) {
  const random = seededRandom(seed ^ 0x9e3779b9)
  return {
    bandTilt: (random() - 0.5) * 1.15,
    orbitTilt: (random() - 0.5) * 1.1,
    orbitPhase: (random() < 0.5 ? 0 : Math.PI) + (random() - 0.5) * 1.2,
    spinPeriod: 16 + random() * 20,
    bands: Array.from({ length: 7 }, (_, index) => ({
      latitude: (index - 3) * 0.26 + (random() - 0.5) * 0.09,
      width: 0.065 + random() * 0.15,
      wave: 0.05 + random() * 0.17,
      phase: random() * fullCircle,
    })),
    craters: Array.from({ length: 18 }, () => ({
      latitude: (random() - 0.5) * 2.45,
      longitude: random() * fullCircle,
      radius: 0.055 + random() * 0.13,
    })),
    glints: [
      { x: 14 + random() * 10, y: 15 + random() * 9, size: 3.5 },
      { x: 78 + random() * 8, y: 72 + random() * 12, size: 2.4 },
    ],
  }
}

function circle(ctx, x, y, radius) {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, fullCircle)
}

function surfaceTexture(ctx, radius, shape, texture, phase) {
  ctx.save()
  ctx.rotate(shape.bandTilt)
  if (texture === 'craters') {
    for (const crater of shape.craters) {
      const longitude = crater.longitude + phase
      const depth = Math.cos(longitude)
      if (depth <= 0) continue
      const x = Math.sin(longitude) * Math.cos(crater.latitude) * radius
      const y = Math.sin(crater.latitude) * radius
      const size = crater.radius * radius
      ctx.beginPath()
      ctx.ellipse(x, y, size * Math.max(depth, 0.25), size, 0, 0, fullCircle)
      ctx.fillStyle = 'rgba(17, 27, 47, 0.25)'
      ctx.fill()
      ctx.lineWidth = 0.8
      ctx.strokeStyle = 'rgba(255, 249, 228, 0.35)'
      ctx.stroke()
    }
  } else {
    const swirls = texture === 'swirls'
    shape.bands.forEach((band, index) => {
      ctx.beginPath()
      for (let sample = 0; sample <= 16; sample++) {
        const surfaceX = (sample / 8 - 1) * 1.12
        const longitude = Math.asin(Math.max(-1, Math.min(1, surfaceX)))
        const wave = longitude * (swirls ? 4.1 : 2.3) + phase + band.phase
        const curl = swirls ? Math.cos(wave * 1.7 + index) * 0.09 : 0
        const y = (band.latitude + band.wave * Math.sin(wave) + curl) * radius
        if (sample === 0) ctx.moveTo(surfaceX * radius, y)
        else ctx.lineTo(surfaceX * radius, y)
      }
      ctx.lineWidth = band.width * radius * (swirls ? 0.85 : 1.25)
      ctx.strokeStyle = index % 2 ? 'rgba(17, 27, 47, 0.23)' : 'rgba(255, 249, 229, 0.40)'
      ctx.stroke()
    })
  }
  ctx.restore()
}

function ringArc(ctx, radius, tilt, front, color) {
  const start = front ? 0 : Math.PI
  ctx.beginPath()
  ctx.ellipse(50, 50, radius * 1.50, radius * 0.45, tilt, start, start + Math.PI)
  ctx.strokeStyle = color
  ctx.globalAlpha = front ? 0.9 : 0.58
  ctx.lineWidth = 4
  ctx.stroke()
  ctx.strokeStyle = '#f1e8d5'
  ctx.globalAlpha = front ? 0.66 : 0.33
  ctx.lineWidth = 1.1
  ctx.stroke()
  ctx.globalAlpha = 1
}

function satellite(ctx, x, y, radius) {
  const light = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.4, 0, x, y, radius)
  light.addColorStop(0, '#faf0d7')
  light.addColorStop(0.45, '#c8bfd2')
  light.addColorStop(1, '#766e8d')
  circle(ctx, x, y, radius)
  ctx.fillStyle = light
  ctx.fill()
}

export function drawPlanet(ctx, options, shape, seconds = 0) {
  const { color, ring, moon, shadow, glint, texture } = options
  const { orbitTilt } = shape
  const radius = moon ? 28 : ring ? 30 : 36
  const orbit = shape.orbitPhase + seconds / 27 * fullCircle
  const orbitX = Math.cos(orbit) * radius * 1.55
  const orbitY = Math.sin(orbit) * radius * 0.82
  const moonX = 50 + orbitX * Math.cos(orbitTilt) - orbitY * Math.sin(orbitTilt)
  const moonY = 50 + orbitX * Math.sin(orbitTilt) + orbitY * Math.cos(orbitTilt)

  ctx.setTransform(ctx.canvas.width / 100, 0, 0, ctx.canvas.height / 100, 0, 0)
  ctx.clearRect(0, 0, 100, 100)
  if (moon && orbitY < 0) satellite(ctx, moonX, moonY, 5.5)
  if (ring) ringArc(ctx, radius, orbitTilt, false, color)

  ctx.save()
  ctx.translate(50, 50)
  circle(ctx, 0, 0, radius)
  ctx.fillStyle = color
  ctx.fill()
  ctx.clip()
  surfaceTexture(ctx, radius, shape, texture, seconds / shape.spinPeriod * fullCircle)
  const shading = ctx.createRadialGradient(-radius * 0.37, -radius * 0.52, 1, 0, 0, radius * 1.05)
  const strength = shadow / 100
  shading.addColorStop(0, `rgba(255, 252, 232, ${0.19 + strength * 0.45})`)
  shading.addColorStop(0.57, 'rgba(255, 252, 232, 0)')
  shading.addColorStop(0.84, `rgba(15, 25, 50, ${strength * 0.30})`)
  shading.addColorStop(1, `rgba(15, 25, 50, ${strength * 0.84})`)
  ctx.fillStyle = shading
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2)
  ctx.restore()

  if (ring) ringArc(ctx, radius, orbitTilt, true, color)
  if (moon && orbitY >= 0) satellite(ctx, moonX, moonY, 5.5)
  if (glint) {
    shape.glints.forEach(({ x, y, size }, index) => {
      ctx.globalAlpha = 0.73 + Math.sin(seconds * 0.9 + index) * 0.2
      ctx.beginPath()
      ctx.moveTo(x, y - size)
      ctx.lineTo(x + 1.1, y - 0.8)
      ctx.lineTo(x + size * 0.8, y)
      ctx.lineTo(x + 1.1, y + 0.8)
      ctx.lineTo(x, y + size)
      ctx.lineTo(x - 1.1, y + 0.8)
      ctx.lineTo(x - size * 0.8, y)
      ctx.lineTo(x - 1.1, y - 0.8)
      ctx.closePath()
      ctx.fillStyle = '#c09969'
      ctx.fill()
    })
    ctx.globalAlpha = 1
  }
}

export function initPlanet() {
  const byId = id => document.getElementById(id)
  const image = byId('brand-planet')
  const previewImage = byId('classic-planet-preview')
  const canvas = byId('generated-planet')
  const preview = byId('generated-planet-preview')
  const mode = byId('planet-mode')
  const rawClassicSeed = readStored(classicSeedKey)
  const classicSeed = rawClassicSeed && /^\d{1,10}$/.test(rawClassicSeed) && isSeed(Number(rawClassicSeed))
    ? Number(rawClassicSeed) : randomSeed()
  store(classicSeedKey, String(classicSeed))
  styleClassic([image, previewImage], classicSeed)
  image.parentElement.title = `Dot by QCA · 星球编号 ${classicSeed}`

  const headerCtx = canvas.getContext('2d')
  const previewCtx = preview.getContext('2d')
  if (!headerCtx || !previewCtx) {
    mode.disabled = true
    return () => {}
  }

  const parameters = byId('planet-parameters')
  const seed = byId('planet-seed')
  const fields = Object.fromEntries(['texture', 'color', 'shadow', ...switches].map(key => [key, byId('planet-' + key)]))
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const options = loadSettings(classicSeed)
  let shape = geometry(options.seed)
  let previewVisible = false
  let elapsed = 0
  let previousFrame
  let frame

  const generated = () => options.mode === 'generated'
  const animate = () => generated() && options.motion && !reducedMotion.matches && !document.hidden
  function paint() {
    const seconds = animate() ? elapsed : 0
    drawPlanet(headerCtx, options, shape, seconds)
    if (previewVisible) drawPlanet(previewCtx, options, shape, seconds)
  }
  function tick(time) {
    if (!animate()) {
      frame = undefined
      return
    }
    if (previousFrame === undefined || time - previousFrame >= 32) {
      if (previousFrame !== undefined) elapsed += Math.min((time - previousFrame) / 1000, 0.1)
      previousFrame = time
      paint()
    }
    frame = requestAnimationFrame(tick)
  }
  function update() {
    image.hidden = previewImage.hidden = generated()
    canvas.hidden = preview.hidden = parameters.hidden = !generated()
    image.parentElement.title = `Dot by QCA · 星球编号 ${generated() ? options.seed : classicSeed}`
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = previousFrame = undefined
    if (generated()) paint()
    if (animate()) frame = requestAnimationFrame(tick)
  }
  function syncFields() {
    mode.value = options.mode
    seed.value = options.seed
    for (const [key, control] of Object.entries(fields)) {
      if (switches.includes(key)) control.checked = options[key]
      else control.value = options[key]
    }
  }
  function save() {
    store(settingsKey, JSON.stringify(options))
    update()
  }
  function selectSeed(value) {
    Object.assign(options, planetPreset(value))
    shape = geometry(value)
    elapsed = 0
    syncFields()
    save()
  }
  mode.addEventListener('change', () => {
    options.mode = mode.value
    save()
  })
  byId('planet-seed-form').addEventListener('submit', event => {
    event.preventDefault()
    if (isSeed(seed.valueAsNumber)) selectSeed(seed.valueAsNumber)
  })
  byId('planet-random').addEventListener('click', () => {
    const next = randomSeed()
    selectSeed(next === options.seed ? (next + 1) >>> 0 : next)
  })
  for (const [key, control] of Object.entries(fields)) {
    const toggle = switches.includes(key)
    control.addEventListener(key === 'shadow' ? 'input' : 'change', () => {
      options[key] = toggle ? control.checked : key === 'shadow' ? Number(control.value) : control.value
      save()
    })
  }
  reducedMotion.addEventListener('change', update)
  document.addEventListener('visibilitychange', update)
  syncFields()
  update()
  return visible => {
    previewVisible = visible
    if (visible && generated()) paint()
  }
}
