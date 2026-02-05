# Trinkets Carousel Architecture

This document provides a comprehensive guide to the carousel component's structure, animations, and interaction patterns. Use this as a reference when implementing new animations or transitions.

---

## Project Structure

```
Trinkets/
├── index.html              # Entry point, contains DOM structure
├── config.js               # Are.na API credentials
├── LEARNINGS.md            # This architecture document
├── .gitignore              # Excludes internal docs, .agent/
└── assets/
    ├── script.js           # All JavaScript (ES Module)
    ├── style.css           # Styling and layout
    ├── fonts/              # OT Brut font files
    ├── favicon-96x96.png
    └── position.svg        # Rotation indicator icon
```

**Technology Stack:**
- Animation: GSAP 3.14.2 + Draggable + InertiaPlugin + MotionPathPlugin
- Data Source: Are.na API v3 with Bearer token auth
- Architecture: Vanilla ES Modules, no build step
- Deployment: Vercel (auto-deploy on push to main)

**GSAP Note:** All GSAP plugins are now **100% free** since Webflow acquired GreenSock (2024). Use main `gsap` package, not `gsap-trial`.
- CDN: `https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/[PluginName].min.js`
- Docs: https://gsap.com/docs/v3/

---

## DOM Structure

```html
<section class="mwg_effect023">
    ├── <div class="header">
    │       └── <h1>Trinkets</h1>
    │
    ├── <div class="position-indicator">
    │       └── <img class="position-icon" />
    │
    └── <div class="container">           ← The wheel (300vw × 300vw)
            └── <div class="inner-media">  ← One per item (N total)
                    └── <div class="media-wrapper">  ← Click target, has source URL
                            └── <img class="media" /> or <video class="media" />
</section>
```

### Element Roles

| Element | Role | Key Properties |
|---------|------|----------------|
| `.mwg_effect023` | Root section | `height: 100vh` |
| `.header` | Title display | Fixed at top, centered |
| `.position-indicator` | Rotation feedback | Fixed at bottom, contains rotating icon |
| `.container` | **The wheel itself** | 300vw × 300vw square, rotates as a unit |
| `.inner-media` | Card wrapper | Full-size overlay, each rotated to position on wheel |
| `.media-wrapper` | Click target | Has `data-source-url`, pointer-events |
| `.media` | Actual image/video | 100% of wrapper, `object-fit: contain` |

---

## Interaction Model

### Three Input Methods

1. **Scroll** - Continuous rotation, no snapping
2. **Drag** - Rotation with inertia and card snapping (elastic spring)
3. **Arrow Keys** - Step through cards with playful bounce

### Click to Open Source

Clicking a card opens its source URL in a new tab:
- Prefers original source (Twitter, Pinterest, design blogs)
- Falls back to Are.na block page for items without source or with raw CDN links
- Drag detection prevents accidental opens while rotating

```javascript
function getSourceUrl(block) {
    const sourceUrl = block.source?.url;

    // Filter out raw CDN links
    if (sourceUrl) {
        const isCdnLink = sourceUrl.includes('cdninstagram.com') ||
                          sourceUrl.includes('i.pinimg.com/originals');
        if (!isCdnLink) return sourceUrl;
    }

    // Fall back to Are.na block page
    return `https://www.are.na/block/${block.id}`;
}
```

---

## Drag Interaction

Uses GSAP Draggable + InertiaPlugin for physics-based rotation:

```javascript
Draggable.create(container, {
    type: 'rotation',
    inertia: true,
    snap: {
        rotation: (endValue) => Math.round(endValue / snapAngle) * snapAngle
    },
    inertia: {
        rotation: {
            velocity: 'auto',
            end: (endValue) => Math.round(endValue / snapAngle) * snapAngle
        },
        duration: { min: 0.3, max: 1 },
        ease: 'elastic.out(0.8, 0.4)'  // Playful spring
    }
});
```

**Snap angle:** `360 / totalCards` degrees

**Spring feel:** `elastic.out(0.8, 0.4)` creates gentle oscillation on settle

---

## Arrow Key Navigation

```javascript
function setupKeyboardNavigation() {
    document.addEventListener('keydown', (e) => {
        if (isAnimating || isDetailView) return;

        let direction = 0;
        if (e.key === 'ArrowLeft') direction = 1;
        else if (e.key === 'ArrowRight') direction = -1;
        else return;

        const targetRotation = incr + (snapAngle * direction);
        incr = targetRotation;

        gsap.to(container, {
            rotation: targetRotation,
            duration: 0.5,
            ease: 'back.out(2)',  // Playful overshoot
            onUpdate: () => positionRotTo(-gsap.getProperty(container, 'rotation'))
        });
    });
}
```

---

## Entry Animation Phases

```
Time:  0s          3.5s    4.1s                      6.9s
       │            │       │                          │
       ├────────────┼───────┼──────────────────────────┤
       │  Cards     │ Pause │         Zoom             │
       │  Reveal    │       │                          │
       ├───────────────────────────────────────────────┤
       │            Container Rotation (-45° → 0°)     │
       └───────────────────────────────────────────────┘
                                        │
                                        └── Position indicator slides in
```

**Final state:**
```javascript
scale: 1.25
rotation: 0
y: 0.5 * window.innerHeight
```

---

## Responsive Behavior

At `max-width: 900px`:
- Container expands: 300vw → 800vw
- Container offset: -100vw → -350vw
- Card size: 20vw × 26vw → 40vw × 52vw

### Viewport Resize Handling

Debounced resize listener recalculates y position:

```javascript
function updateCarouselPosition() {
    if (isAnimating || isDetailView) return;

    gsap.to(container, {
        y: 0.5 * window.innerHeight,
        duration: 0.3,
        ease: 'power2.out',
        overwrite: 'auto'
    });
}
```

---

## Function Reference

| Function | Purpose | When Called |
|----------|---------|-------------|
| `fetchContents()` | Load Are.na channel data | On init |
| `buildMediaElements(blocks)` | Create DOM from API data | After fetch |
| `getSourceUrl(block)` | Get source URL or Are.na fallback | During build |
| `initCarousel(medias)` | Set initial transforms | Before entry animation |
| `playEntryAnimation()` | Run reveal + zoom sequence | After images load |
| `setupCarouselAnimations()` | Create quickTo functions | After entry completes |
| `setupDraggable()` | Init drag rotation with inertia | After entry completes |
| `setupCardClickHandlers()` | Add click-to-open-source | After entry completes |
| `setupKeyboardNavigation()` | Arrow key rotation | After entry completes |
| `setupWheelListener()` | Listen for scroll events | Before entry |
| `setupViewportObserver()` | Pause videos outside viewport | After entry |
| `setupResizeListener()` | Recenter on viewport resize | After entry |
| `updateCarouselPosition()` | Recalculate y offset | On resize (debounced) |
| `setPositionIndicatorActive()` | Trigger active state | On any interaction |

---

## State Variables

```javascript
// Core state
let isAnimating = true;           // Blocks interaction during entry
let isDetailView = false;         // Detail view open? (currently disabled)
let activeDetailMedia = null;     // Reference to expanded card
let incr = 0;                     // Cumulative rotation from wheel scroll
let detailOriginalState = null;   // Stored position for restore

// Animation functions (set after entry)
let rotTo;                        // Carousel rotation quickTo
let positionRotTo;                // Position indicator rotation quickTo

// Position indicator state
let positionIdleTimeout = null;   // Timeout for idle transition
let positionIdleTween = null;     // Active idle animation (for kill)

// Navigation state
let navigationTimeline = null;    // Active navigation (for kill)

// Resize handling
let resizeTimeout = null;         // Debounce timeout for resize events

// Drag detection
let isDragging = false;           // Prevents click during drag
```

---

## Position Indicator

Rotates **opposite** to carousel (clockwise when scrolling down).

**States:**
- **Active**: scale: 1, opacity: 1 (on any interaction)
- **Idle**: scale: 0.6, opacity: 0.5 (after 0.8s of no interaction)

**Entrance**: Slides in from bottom near end of entry animation.

---

## Detail View (Currently Disabled)

Detail view code exists but is disabled (`setupDetailView()` returns early). The implementation uses a two-phase animation approach with MotionPathPlugin for positioning. See code for details if re-enabling.

---

## Are.na Data Structure

Each block from the API includes:
- `id` - Unique identifier (used for Are.na fallback URL)
- `title` - Block title
- `type` - "Image", "Attachment", etc.
- `image` - Object with `small`, `medium`, `large` size URLs
- `source.url` - Original source URL (if available)
- `source.title` - Source page title
- `attachment` - For video attachments, contains `url` and `content_type`

**Source URL logic:**
1. Use `block.source.url` if available and not a raw CDN link
2. Otherwise: `https://www.are.na/block/${block.id}`
