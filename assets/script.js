import { CONFIG } from '../config.js';

// Enable GPU acceleration globally for all animations
gsap.defaults({ force3D: true, lazy: false });

// Smooth out lag spikes - if CPU freezes for >1000ms, adjust timing to prevent jarring jumps
gsap.ticker.lagSmoothing(1000, 16);

// Register plugins
gsap.registerPlugin(MotionPathPlugin, Draggable, InertiaPlugin);

const API_BASE = 'https://api.are.na/v3';

// State
let isAnimating = true; // Block interaction during entry
let isDetailView = false;
let activeDetailMedia = null;
let incr = 0;
let rotTo, positionRotTo; // Will be set after entry

// Position indicator state
let positionIdleTimeout = null;
let positionIdleTween = null;

// Detail view state - store original values for restore
let detailOriginalState = null;

// Navigation state - track active navigation timeline for interruption handling
let navigationTimeline = null;

// Resize handling state
let resizeTimeout = null;

// Drag detection state
let isDragging = false;

// Central card tracking
let currentCentralWrapper = null;

// Fetch Are.na channel contents
async function fetchContents() {
    const response = await fetch(
        `${API_BASE}/channels/${CONFIG.ARENA_CHANNEL_SLUG}/contents`,
        { headers: { 'Authorization': `Bearer ${CONFIG.ARENA_API_TOKEN}` } }
    );
    if (!response.ok) throw new Error('Failed to fetch contents');
    return response.json();
}

function getImageUrl(block, size = CONFIG.IMAGE_SIZE) {
    if (!block.image) return null;
    const sizeData = block.image[size] || block.image.medium;
    return sizeData?.src || null;
}

// Get source URL for a block - prefer actual source, fall back to Are.na
function getSourceUrl(block) {
    const sourceUrl = block.source?.url;

    // Check if it's a usable source (not a raw CDN link)
    if (sourceUrl) {
        const isCdnLink = sourceUrl.includes('cdninstagram.com') ||
                          sourceUrl.includes('i.pinimg.com/originals');
        if (!isCdnLink) {
            return sourceUrl;
        }
    }

    // Fall back to Are.na block page
    return `https://www.are.na/block/${block.id}`;
}

// Mobile breakpoint matches CSS media query
function isMobile() {
    return window.innerWidth <= 900;
}

// Get wheel size multiplier (matches CSS: 300vw desktop, 800vw mobile)
function getWheelMultiplier() {
    return isMobile() ? 8 : 3;
}

// Calculate initial scale to fit wheel in viewport (~70vh diameter)
function getInitialScale() {
    // Container is 300vw (desktop) or 800vw (mobile)
    const containerSize = getWheelMultiplier() * window.innerWidth;
    const targetSize = 70 * window.innerHeight / 100;
    return targetSize / containerSize;
}

// Build media elements from Are.na data
function buildMediaElements(blocks) {
    const container = document.querySelector('.mwg_effect023 .container');
    container.innerHTML = ''; // Clear loading message

    const loadPromises = [];

    blocks.forEach((block) => {
        const innerMedia = document.createElement('div');
        innerMedia.className = 'inner-media';

        // Check if this is a video attachment
        const isVideo = block.type === 'Attachment' &&
            block.attachment &&
            block.attachment.content_type &&
            block.attachment.content_type.startsWith('video/');

        // Create wrapper for border-radius clipping
        const wrapper = document.createElement('div');
        wrapper.className = 'media-wrapper';

        // Store source URL and add click handler
        const sourceUrl = getSourceUrl(block);
        wrapper.dataset.sourceUrl = sourceUrl;

        if (isVideo) {
            // Create video element
            const video = document.createElement('video');
            video.className = 'media';
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', ''); // iOS compatibility

            // Set poster image from Are.na thumbnail
            const posterSrc = getImageUrl(block);
            if (posterSrc) {
                video.poster = posterSrc;
            }

            // Set video source
            video.src = block.attachment.url;

            // Track load with promise
            loadPromises.push(
                new Promise((resolve) => {
                    video.onloadeddata = () => resolve();
                    video.onerror = () => resolve(); // Resolve even on error
                })
            );

            wrapper.appendChild(video);
        } else {
            // Create image element (existing logic)
            const img = document.createElement('img');
            img.className = 'media';
            img.alt = block.title || '';
            img.draggable = false;

            const src = getImageUrl(block);
            if (src) {
                img.src = src;
                // Track load with promise
                loadPromises.push(
                    new Promise((resolve) => {
                        if (img.complete) {
                            resolve();
                        } else {
                            img.onload = () => resolve();
                            img.onerror = () => resolve(); // Resolve even on error to not block
                        }
                    })
                );
            }

            wrapper.appendChild(img);
        }

        innerMedia.appendChild(wrapper);

        container.appendChild(innerMedia);
    });

    return {
        medias: container.querySelectorAll('.mwg_effect023 .inner-media'),
        loadPromises
    };
}

// Setup viewport observer for video pause/play
function setupViewportObserver() {
    const videos = document.querySelectorAll('.mwg_effect023 video.media');

    if (videos.length === 0) {
        return; // No videos to observe
    }

    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                const video = entry.target;

                if (entry.isIntersecting) {
                    // Video is in viewport - play it
                    video.play().catch(err => {
                        // Ignore autoplay errors (browser policy)
                        console.log('Video autoplay prevented:', err);
                    });
                } else {
                    // Video is out of viewport - pause it
                    video.pause();
                }
            });
        },
        {
            root: null, // Use viewport as root
            threshold: 0.1 // Trigger when 10% visible
        }
    );

    // Observe all video elements
    videos.forEach(video => observer.observe(video));

    console.log(`Observing ${videos.length} video(s) for viewport visibility`);
}

// Setup wheel listener
function setupWheelListener() {
    window.addEventListener('wheel', (e) => {
        // Block scrolling entirely when in detail view
        if (isDetailView) {
            e.preventDefault();
            return;
        }
        if (isAnimating) return; // Block during entry animation

        const deltaY = e.deltaY;
        incr -= deltaY / 40;
        rotTo(incr);
        positionRotTo(-incr); // Rotate opposite to carousel (clockwise on scroll down)

        // Trigger position indicator active state
        setPositionIndicatorActive();

        // Update central card for cursor
        updateCentralCard();
    }, { passive: false });
}

// Position indicator idle/active state management
function setPositionIndicatorActive() {
    const indicator = document.querySelector('.mwg_effect023 .position-indicator');

    // Kill any running idle animation
    if (positionIdleTween) {
        positionIdleTween.kill();
        positionIdleTween = null;
    }

    // Clear existing idle timeout
    if (positionIdleTimeout) {
        clearTimeout(positionIdleTimeout);
    }

    // Snap to active state (full size, full opacity) with snappy easing
    gsap.to(indicator, {
        scale: 1,
        opacity: 1,
        duration: 0.2,
        ease: 'power2.out',
        overwrite: true
    });

    // Transition to idle state after carousel settles (matches 0.8s quickTo duration)
    positionIdleTimeout = setTimeout(() => {
        positionIdleTween = gsap.to(indicator, {
            scale: 0.6,
            opacity: 0.5,
            duration: 0.6,
            ease: 'power2.inOut'
        });
    }, 800);
}

// Initialize carousel animation (after entry)
function setupCarouselAnimations() {
    const container = document.querySelector('.mwg_effect023 .container');

    // Rotate container on wheel
    rotTo = gsap.quickTo(container, 'rotation', {
        duration: 0.8,
        ease: 'power4'
    });

    // Position indicator rotates opposite to carousel (clockwise when scrolling down)
    positionRotTo = gsap.quickTo('.mwg_effect023 .position-icon', 'rotation', {
        duration: 0.8,
        ease: 'power4'
    });
}

// Update which card is in the central position
function updateCentralCard() {
    const allWrappers = document.querySelectorAll('.mwg_effect023 .media-wrapper');
    const total = allWrappers.length;
    if (total === 0) return;

    const snapAngle = 360 / total;

    // Normalize incr to 0-360 range
    let normalizedRotation = ((incr % 360) + 360) % 360;

    // Find which card index is at the top (central position)
    // Card at index i is central when container rotation = -i * snapAngle
    // So centralIndex = -rotation / snapAngle (mod total)
    let centralIndex = Math.round(-normalizedRotation / snapAngle) % total;
    if (centralIndex < 0) centralIndex += total;

    const newCentralWrapper = allWrappers[centralIndex];

    // Only update if central card changed
    if (newCentralWrapper !== currentCentralWrapper) {
        if (currentCentralWrapper) {
            currentCentralWrapper.classList.remove('central');
        }
        newCentralWrapper.classList.add('central');
        currentCentralWrapper = newCentralWrapper;
    }
}

// Setup drag interaction
function setupDraggable() {
    const container = document.querySelector('.mwg_effect023 .container');
    const totalCards = document.querySelectorAll('.mwg_effect023 .inner-media').length;
    const snapAngle = 360 / totalCards;

    Draggable.create(container, {
        type: 'rotation',
        inertia: {
            rotation: {
                velocity: 'auto',
                end: function(endValue) {
                    return Math.round(endValue / snapAngle) * snapAngle;
                }
            }
        },
        snap: {
            rotation: function(endValue) {
                return Math.round(endValue / snapAngle) * snapAngle;
            }
        },
        onThrowComplete: function() {
            // Elastic settle animation after inertia ends
            const snappedRotation = Math.round(this.rotation / snapAngle) * snapAngle;
            gsap.to(container, {
                rotation: snappedRotation,
                duration: 0.6,
                ease: 'elastic.out(1, 0.4)',
                overwrite: true
            });
            incr = snappedRotation;
            updateCentralCard();
        },
        onDragStart: function () {
            isDragging = true;
        },
        onDrag: function () {
            if (isDetailView) return;
            incr = this.rotation;
            positionRotTo(-incr);
            setPositionIndicatorActive();
            updateCentralCard();
        },
        onRelease: function () {
            // Small delay to allow click events to check isDragging
            setTimeout(() => { isDragging = false; }, 50);
        },
        onThrowUpdate: function () {
            if (isDetailView) return;
            incr = this.rotation;
            positionRotTo(-incr);
            updateCentralCard();
        }
    });
}

// Setup click handlers on cards to open source URLs
function setupCardClickHandlers() {
    document.querySelectorAll('.mwg_effect023 .media-wrapper').forEach(wrapper => {
        wrapper.addEventListener('click', () => {
            // Don't open if we were dragging
            if (isDragging) return;

            const sourceUrl = wrapper.dataset.sourceUrl;
            if (sourceUrl) {
                window.open(sourceUrl, '_blank');
            }
        });
    });
}

// Setup arrow key navigation
function setupKeyboardNavigation() {
    const container = document.querySelector('.mwg_effect023 .container');
    const totalCards = document.querySelectorAll('.mwg_effect023 .inner-media').length;
    const snapAngle = 360 / totalCards;

    document.addEventListener('keydown', (e) => {
        if (isAnimating || isDetailView) return;

        let direction = 0;
        if (e.key === 'ArrowLeft') direction = 1;
        else if (e.key === 'ArrowRight') direction = -1;
        else return;

        e.preventDefault();

        // Calculate target rotation (snap to next card)
        const targetRotation = incr + (snapAngle * direction);
        incr = targetRotation;

        // Animate with playful snap
        gsap.to(container, {
            rotation: targetRotation,
            duration: 0.8,
            ease: 'elastic.out(1, 0.35)',
            onUpdate: function() {
                positionRotTo(-gsap.getProperty(container, 'rotation'));
                updateCentralCard();
            }
        });

        setPositionIndicatorActive();
    });
}

// Update carousel position on viewport resize
function updateCarouselPosition() {
    if (isAnimating || isDetailView) return;

    const container = document.querySelector('.mwg_effect023 .container');
    const winHeight = window.innerHeight;

    // Maintain the same y offset calculation as entry animation finale
    const yOffset = 0.5 * winHeight;

    gsap.to(container, {
        y: yOffset,
        duration: 0.3,
        ease: 'power2.out',
        overwrite: 'auto'
    });
}

// Setup resize listener (debounced)
function setupResizeListener() {
    window.addEventListener('resize', () => {
        // Debounce resize events
        if (resizeTimeout) {
            clearTimeout(resizeTimeout);
        }
        resizeTimeout = setTimeout(() => {
            updateCarouselPosition();
        }, 100);
    });
}

// Entry animation
async function playEntryAnimation(loadPromises, medias) {
    const container = document.querySelector('.mwg_effect023 .container');
    const winHeight = window.innerHeight;

    // Wait for all images to load
    await Promise.all(loadPromises);
    console.log('All images loaded, starting reveal animation');

    // Shuffle media order for random reveal
    const shuffled = [...medias].sort(() => Math.random() - 0.5);

    // Calculate stagger timing: total ~3.5s for all cards
    const totalRevealTime = 3.5;
    const staggerDelay = totalRevealTime / shuffled.length;
    const pauseTime = 0.6;
    const zoomTime = 2.8;
    const totalAnimTime = totalRevealTime + pauseTime + zoomTime; // 6.9s

    // Apply will-change just before animation
    container.style.willChange = 'transform';

    // Create master timeline for container animations
    const containerTimeline = gsap.timeline({
        onComplete: () => {
            // Remove will-change after animation to free GPU memory
            container.style.willChange = 'auto';
        }
    });

    // Phase 1: Rotation during entire animation (0 to 6.9s)
    containerTimeline.to(container, {
        rotation: 0,
        duration: totalAnimTime,
        ease: 'power1.out',
        force3D: true
    }, 0);

    // Phase 2: Zoom (starts at 4.1s = after reveal + pause)
    // Scale 1.25 = 25% larger, with y offset to keep cards in viewport
    const finalScale = 1.25;
    const yOffset = 0.5 * winHeight; // Pull up slightly to compensate for larger scale
    containerTimeline.to(container, {
        scale: finalScale,
        y: yOffset,
        duration: zoomTime,
        ease: 'power2.inOut',
        force3D: true
    }, totalRevealTime + pauseTime);

    // Phase 3: Position indicator entrance (slides in near end of zoom)
    const positionIndicator = document.querySelector('.mwg_effect023 .position-indicator');
    const indicatorEntranceStart = totalRevealTime + pauseTime + zoomTime - 1; // 1 second before end

    // Set initial position (below viewport)
    gsap.set(positionIndicator, { y: 80 });

    containerTimeline.to(positionIndicator, {
        y: 0,
        opacity: 1,
        duration: 0.8,
        ease: 'power2.out',
        force3D: true,
        onComplete: () => {
            // Start idle timeout after entrance (matches carousel settle time)
            positionIdleTimeout = setTimeout(() => {
                positionIdleTween = gsap.to(positionIndicator, {
                    scale: 0.6,
                    opacity: 0.5,
                    duration: 0.6,
                    ease: 'power2.inOut'
                });
            }, 800);
        }
    }, indicatorEntranceStart);

    // Reveal cards one by one in random order (runs in parallel)
    return new Promise((resolve) => {
        gsap.to(shuffled, {
            opacity: 1,
            scale: 1,
            duration: 0.6,
            ease: 'back.out(1.2)',
            stagger: staggerDelay,
            force3D: true,
            onComplete: () => {
                containerTimeline.then(() => {
                    isAnimating = false;
                    resolve();
                });
            }
        });
    });
}

// Initialize carousel (set initial positions)
function initCarousel(medias) {
    const mediasTotal = medias.length;
    const container = document.querySelector('.mwg_effect023 .container');

    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;
    const wheelMultiplier = getWheelMultiplier();

    // Scale to fit entire wheel in ~60vh
    // Container is 300vw (desktop) or 800vw (mobile)
    const wheelSize = wheelMultiplier * winWidth;
    const targetSize = 0.6 * winHeight;
    const initialScale = targetSize / wheelSize;

    // Wheel center is at half the container size
    // To put it at 50vh: translateY = 50vh - wheelCenter
    const wheelCenter = (wheelMultiplier / 2) * winWidth;
    const targetCenter = 0.5 * winHeight;
    const translateY = targetCenter - wheelCenter;

    gsap.set(container, {
        scale: initialScale,
        rotation: -45, // Start rotated so entire animation is one smooth clockwise motion to 0
        y: translateY,
        transformOrigin: 'center center'
    });

    // Cards at normal scale relative to container - they zoom with it
    gsap.set('.mwg_effect023 .media-wrapper', { yPercent: -50 });

    medias.forEach((media, index) => {
        gsap.set(media, {
            rotation: 360 / mediasTotal * index,
            opacity: 0,
            scale: 0
        });
    });
}

// ============ DETAIL VIEW ============
// Two-phase approach:
// Phase 1: Rotate container to bring clicked card to "zero position" (top center)
// Phase 2: From that known position, animate to viewport center with scale

function setupDetailView() {
    // DISABLED: Detail view interaction temporarily disabled for testing
    return;

    const overlay = document.querySelector('.mwg_effect023 .detail-overlay');

    // Click on media cards
    document.querySelectorAll('.mwg_effect023 .media').forEach(media => {
        media.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isAnimating) return;

            // If in detail view, clicking outside the active card closes it
            if (isDetailView) {
                if (media !== activeDetailMedia) {
                    closeDetailView();
                }
                return;
            }

            openDetailView(media);
        });
    });

    // Click overlay to close
    overlay.addEventListener('click', () => {
        if (isDetailView) closeDetailView();
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (!isDetailView) return;

        if (e.key === 'Escape') {
            closeDetailView();
        } else if (e.key === 'ArrowLeft') {
            navigateDetailView(-1);
        } else if (e.key === 'ArrowRight') {
            navigateDetailView(1);
        }
    });
}

function openDetailView(media) {
    isDetailView = true;
    activeDetailMedia = media;

    const container = document.querySelector('.mwg_effect023 .container');
    const overlay = document.querySelector('.mwg_effect023 .detail-overlay');
    const parentInnerMedia = media.closest('.inner-media');
    const allInnerMedias = document.querySelectorAll('.mwg_effect023 .inner-media');
    const total = allInnerMedias.length;

    // ========== ALL DOM MEASUREMENTS FIRST (before any animation) ==========
    // This prevents layout thrashing - measurements trigger forced reflow,
    // so we batch them all at the start before the animation begins

    // Find index of clicked card
    const clickedIndex = [...allInnerMedias].findIndex(m => m === parentInnerMedia);

    // Each inner-media has rotation: 360/total * index
    const innerMediaRotation = 360 / total * clickedIndex;

    // Current container rotation (from wheel scroll)
    const currentContainerRotation = gsap.getProperty(container, 'rotation') || 0;

    // Measure element dimensions (triggers reflow - do this ONCE before animation)
    const elementW = media.offsetWidth;
    const elementH = media.offsetHeight;
    const naturalW = media.naturalWidth || media.videoWidth || elementW;
    const naturalH = media.naturalHeight || media.videoHeight || elementH;

    // Store original state for restore
    detailOriginalState = {
        containerRotation: currentContainerRotation,
        incr: incr,
        mediaX: gsap.getProperty(media, 'x') || 0,
        mediaY: gsap.getProperty(media, 'y') || 0,
        mediaScale: gsap.getProperty(media, 'scale') || 1,
        transformOrigin: media.style.transformOrigin || ''
    };

    // ========== PRE-CALCULATE VALUES THAT DON'T DEPEND ON ROTATION ==========

    // Calculate target scale based on media dimensions
    const maxW = window.innerWidth * 0.85;
    const maxH = window.innerHeight * 0.85;
    const targetScale = Math.min(maxW / elementW, maxH / elementH);

    // Calculate rendered size with object-fit: contain
    const elementAspect = elementW / elementH;
    const imageAspect = naturalW / naturalH;
    const renderedH = imageAspect > elementAspect
        ? elementW / imageAspect
        : elementH;

    // For object-position: 50% 100% (bottom-aligned):
    // Visual center X = 0.5 (horizontally centered)
    // Visual center Y = (elementH - renderedH/2) / elementH
    const visualCenterX = 0.5;
    const visualCenterY = (elementH - renderedH / 2) / elementH;

    // Set transform-origin BEFORE animation so scaling doesn't cause shift
    media.style.transformOrigin = `${visualCenterX * 100}% ${visualCenterY * 100}%`;

    // Calculate target container rotation (shortest path)
    let targetContainerRotation = -innerMediaRotation;
    let rotationDelta = targetContainerRotation - currentContainerRotation;
    while (rotationDelta > 180) rotationDelta -= 360;
    while (rotationDelta < -180) rotationDelta += 360;
    targetContainerRotation = currentContainerRotation + rotationDelta;

    // Filter other items for batch opacity animation
    const otherItems = [...allInnerMedias].filter((_, i) => i !== clickedIndex);

    // ========== APPLY will-change JUST BEFORE ANIMATION ==========
    media.style.willChange = 'transform';
    container.style.willChange = 'transform';
    overlay.style.willChange = 'opacity';

    // Elevate only the active inner-media above overlay (do this early so it's visible during animation)
    container.classList.add('detail-view-active');
    parentInnerMedia.classList.add('detail-active');
    media.classList.add('detail-active');

    // ========== PHASE 1: ROTATE CONTAINER ==========
    // We must complete the rotation BEFORE calculating the position delta,
    // because getRelativePosition() returns values in the container's coordinate system.
    // If we calculate delta before rotation and apply it after, the coordinates are wrong.
    const phase1 = gsap.timeline();

    // Rotate container to center the card
    phase1.to(container, {
        rotation: targetContainerRotation,
        duration: 0.5,
        ease: 'power2.out'
    }, 0);

    // Fade in overlay (runs in parallel with rotation)
    phase1.to(overlay, { opacity: 1, duration: 0.4 }, 0);
    overlay.classList.add('active');

    // Dim other items (runs in parallel with rotation)
    phase1.to(otherItems, { opacity: 0.15, duration: 0.4 }, 0.1);

    // ========== PHASE 2: AFTER ROTATION, CALCULATE DELTA AND ANIMATE TO CENTER ==========
    phase1.call(() => {
        // NOW calculate position delta - container has finished rotating,
        // so the coordinate system is stable and delta will be accurate
        const refPoint = document.createElement('div');
        refPoint.style.cssText = 'position:fixed;left:50%;top:50%;width:1px;height:1px;pointer-events:none;z-index:-1;';
        document.body.appendChild(refPoint);

        const delta = MotionPathPlugin.getRelativePosition(
            media,
            refPoint,
            [visualCenterX, visualCenterY],
            [0.5, 0.5]
        );
        refPoint.remove();

        // Get current media position (may have changed slightly during rotation)
        const currentMediaX = gsap.getProperty(media, 'x') || 0;
        const currentMediaY = gsap.getProperty(media, 'y') || 0;

        // Animate media to viewport center + scale
        gsap.to(media, {
            x: currentMediaX + delta.x,
            y: currentMediaY + delta.y,
            scale: targetScale,
            duration: 0.6,
            ease: 'power2.out',
            onComplete: () => {
                // Remove will-change after animation settles to free GPU memory
                media.style.willChange = 'auto';
                container.style.willChange = 'auto';
                overlay.style.willChange = 'auto';
            }
        });
    });
}

function closeDetailView() {
    if (!isDetailView || !activeDetailMedia || !detailOriginalState) return;

    const media = activeDetailMedia;
    const container = document.querySelector('.mwg_effect023 .container');
    const overlay = document.querySelector('.mwg_effect023 .detail-overlay');
    const parentInnerMedia = media.closest('.inner-media');
    const allInnerMedias = document.querySelectorAll('.mwg_effect023 .inner-media');

    // Get current container rotation (the "centered" position)
    const currentContainerRotation = gsap.getProperty(container, 'rotation') || 0;

    // Apply will-change just before animation
    media.style.willChange = 'transform';
    overlay.style.willChange = 'opacity';

    // Create timeline for coordinated close animation
    const tl = gsap.timeline({
        onComplete: () => {
            // Restore transform-origin
            media.style.transformOrigin = detailOriginalState.transformOrigin;

            // Remove will-change to free GPU memory
            media.style.willChange = 'auto';
            overlay.style.willChange = 'auto';

            // Update incr to match current container rotation for wheel scroll continuity
            incr = currentContainerRotation;

            // Reset state
            isDetailView = false;
            activeDetailMedia = null;
            detailOriginalState = null;

            // Remove elevation classes
            container.classList.remove('detail-view-active');
            parentInnerMedia.classList.remove('detail-active');
            media.classList.remove('detail-active');
        }
    });

    // Animate card back to original x/y/scale
    tl.to(media, {
        x: detailOriginalState.mediaX,
        y: detailOriginalState.mediaY,
        scale: detailOriginalState.mediaScale,
        duration: 0.5,
        ease: 'power2.out'
    }, 0);

    // Fade out overlay
    tl.to(overlay, { opacity: 0, duration: 0.4 }, 0);
    overlay.classList.remove('active');

    // Restore all items opacity - single batched tween instead of forEach
    tl.to(allInnerMedias, { opacity: 1, duration: 0.4 }, 0.1);
}

// Navigate to adjacent card while in detail view
function navigateDetailView(direction) {
    if (!isDetailView || !activeDetailMedia) return;

    // Kill any in-progress navigation
    if (navigationTimeline) {
        navigationTimeline.kill();
        navigationTimeline = null;
    }

    const container = document.querySelector('.mwg_effect023 .container');
    const allMedias = [...document.querySelectorAll('.mwg_effect023 .media')];
    const allInnerMedias = document.querySelectorAll('.mwg_effect023 .inner-media');
    const total = allMedias.length;

    // Find current and next indices
    const currentIndex = allMedias.indexOf(activeDetailMedia);
    const nextIndex = (currentIndex + direction + total) % total;
    const nextMedia = allMedias[nextIndex];

    // Store references before animation
    const currentMedia = activeDetailMedia;
    const currentParent = currentMedia.closest('.inner-media');
    const nextParent = nextMedia.closest('.inner-media');

    // Store current card's original state (for its return position)
    const currentOriginalState = { ...detailOriginalState };

    // ========== MEASUREMENTS FOR NEXT CARD ==========
    const nextElementW = nextMedia.offsetWidth;
    const nextElementH = nextMedia.offsetHeight;
    const nextNaturalW = nextMedia.naturalWidth || nextMedia.videoWidth || nextElementW;
    const nextNaturalH = nextMedia.naturalHeight || nextMedia.videoHeight || nextElementH;

    // Calculate target scale for next card
    const maxW = window.innerWidth * 0.85;
    const maxH = window.innerHeight * 0.85;
    const nextTargetScale = Math.min(maxW / nextElementW, maxH / nextElementH);

    // Calculate visual center for next card
    const nextElementAspect = nextElementW / nextElementH;
    const nextImageAspect = nextNaturalW / nextNaturalH;
    const nextRenderedH = nextImageAspect > nextElementAspect
        ? nextElementW / nextImageAspect
        : nextElementH;
    const nextVisualCenterX = 0.5;
    const nextVisualCenterY = (nextElementH - nextRenderedH / 2) / nextElementH;

    // Store next card's original state for future restore
    detailOriginalState = {
        containerRotation: gsap.getProperty(container, 'rotation') || 0,
        incr: incr,
        mediaX: gsap.getProperty(nextMedia, 'x') || 0,
        mediaY: gsap.getProperty(nextMedia, 'y') || 0,
        mediaScale: gsap.getProperty(nextMedia, 'scale') || 1,
        transformOrigin: nextMedia.style.transformOrigin || ''
    };

    // Calculate next card's inner-media rotation and target container rotation
    const nextInnerMediaRotation = 360 / total * nextIndex;
    const currentContainerRotation = gsap.getProperty(container, 'rotation') || 0;
    let targetContainerRotation = -nextInnerMediaRotation;
    let rotationDelta = targetContainerRotation - currentContainerRotation;
    while (rotationDelta > 180) rotationDelta -= 360;
    while (rotationDelta < -180) rotationDelta += 360;
    targetContainerRotation = currentContainerRotation + rotationDelta;

    // Update active media immediately
    activeDetailMedia = nextMedia;

    // Apply will-change for GPU acceleration
    currentMedia.style.willChange = 'transform';
    nextMedia.style.willChange = 'transform';
    container.style.willChange = 'transform';

    // Set transform-origin for next card before animation
    nextMedia.style.transformOrigin = `${nextVisualCenterX * 100}% ${nextVisualCenterY * 100}%`;

    // Update CSS classes
    currentParent.classList.remove('detail-active');
    currentMedia.classList.remove('detail-active');
    nextParent.classList.add('detail-active');
    nextMedia.classList.add('detail-active');

    // Handle video pause/play
    if (currentMedia.tagName === 'VIDEO') currentMedia.pause();
    if (nextMedia.tagName === 'VIDEO') nextMedia.play();

    // Create navigation timeline
    navigationTimeline = gsap.timeline({
        onComplete: () => {
            // Restore current card's transform-origin
            currentMedia.style.transformOrigin = currentOriginalState.transformOrigin;

            // Remove will-change to free GPU memory
            currentMedia.style.willChange = 'auto';
            nextMedia.style.willChange = 'auto';
            container.style.willChange = 'auto';

            // Update incr for scroll continuity
            incr = targetContainerRotation;

            navigationTimeline = null;
        }
    });

    // Phase 1: Shrink current card back to its wheel position (0-0.3s)
    navigationTimeline.to(currentMedia, {
        x: currentOriginalState.mediaX,
        y: currentOriginalState.mediaY,
        scale: currentOriginalState.mediaScale,
        duration: 0.3,
        ease: 'power2.in'
    }, 0);

    // Phase 2: Rotate container to center next card (0.1-0.5s)
    navigationTimeline.to(container, {
        rotation: targetContainerRotation,
        duration: 0.4,
        ease: 'power2.inOut'
    }, 0.1);

    // Phase 3: After rotation settles, calculate position and expand next card
    navigationTimeline.call(() => {
        // Calculate position delta to viewport center
        const refPoint = document.createElement('div');
        refPoint.style.cssText = 'position:fixed;left:50%;top:50%;width:1px;height:1px;pointer-events:none;z-index:-1;';
        document.body.appendChild(refPoint);

        const delta = MotionPathPlugin.getRelativePosition(
            nextMedia,
            refPoint,
            [nextVisualCenterX, nextVisualCenterY],
            [0.5, 0.5]
        );
        refPoint.remove();

        const currentNextX = gsap.getProperty(nextMedia, 'x') || 0;
        const currentNextY = gsap.getProperty(nextMedia, 'y') || 0;

        // Animate next card to center
        gsap.to(nextMedia, {
            x: currentNextX + delta.x,
            y: currentNextY + delta.y,
            scale: nextTargetScale,
            duration: 0.4,
            ease: 'power2.out'
        });
    }, null, 0.35);
}

// Main init
async function init() {
    try {
        const contents = await fetchContents();
        const blocks = contents.data || [];

        // Filter for images, dedupe, reverse (newest first)
        const seen = new Set();
        const visualBlocks = blocks.filter(b => {
            if (!b.image) return false;
            if (seen.has(b.id)) return false;
            seen.add(b.id);
            return true;
        }).reverse();

        console.log(`Loaded ${visualBlocks.length} blocks from Are.na`);

        if (visualBlocks.length === 0) {
            console.warn('No images found in channel');
            return;
        }

        const { medias, loadPromises } = buildMediaElements(visualBlocks);

        // Setup initial state
        initCarousel(medias);

        // Setup wheel listener (blocked during animation)
        setupWheelListener();

        // Play entry animation once images loaded
        await playEntryAnimation(loadPromises, medias);

        // Setup animation functions AFTER entry animation (so quickTo starts from final state)
        setupCarouselAnimations();

        // Set initial central card
        updateCentralCard();

        // Setup drag interaction
        setupDraggable();

        // Setup card click handlers (open source URLs)
        setupCardClickHandlers();

        // Setup arrow key navigation
        setupKeyboardNavigation();

        // Setup viewport observer for video pause/play
        setupViewportObserver();

        // Setup detail view click handlers
        setupDetailView();

        // Setup resize listener for viewport changes
        setupResizeListener();

        console.log('Entry animation complete, wheel is interactive');

    } catch (error) {
        console.error('Failed to load Are.na content:', error);
    }
}

init();