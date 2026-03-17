const MENU_HIDE_ANIMATION_NAME = 'menuDisappear';
const MENU_HIDE_ANIMATION_MS = 180;
const HIDE_FALLBACK_BUFFER_MS = 50;

const menuAnimationState = new WeakMap();

function parseCssTimeToMs(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) return 0;
    if (normalized.endsWith('ms')) {
        return Number.parseFloat(normalized) || 0;
    }
    if (normalized.endsWith('s')) {
        return (Number.parseFloat(normalized) || 0) * 1000;
    }
    return 0;
}

function getHideAnimationDurationMs(menu) {
    if (!menu || typeof window === 'undefined') {
        return MENU_HIDE_ANIMATION_MS;
    }

    const computedStyle = window.getComputedStyle(menu);
    const animationNames = computedStyle.animationName.split(',').map(name => name.trim());
    const animationDurations = computedStyle.animationDuration.split(',').map(duration => duration.trim());
    const animationDelays = computedStyle.animationDelay.split(',').map(delay => delay.trim());

    const animationIndex = animationNames.findIndex(name => name === MENU_HIDE_ANIMATION_NAME);
    if (animationIndex < 0) {
        return MENU_HIDE_ANIMATION_MS;
    }

    const durationMs = parseCssTimeToMs(animationDurations[animationIndex]);
    const delayMs = parseCssTimeToMs(animationDelays[animationIndex]);
    const totalMs = durationMs + delayMs;
    return totalMs > 0 ? totalMs : MENU_HIDE_ANIMATION_MS;
}

function clearHideAnimationState(menu) {
    const state = menuAnimationState.get(menu);
    if (!state) return;

    if (state.timerId) {
        clearTimeout(state.timerId);
    }
    if (state.onAnimationEnd) {
        menu.removeEventListener('animationend', state.onAnimationEnd);
    }

    menuAnimationState.delete(menu);
}

function finalizeHide(menu) {
    menu.classList.remove('hiding');
    clearHideAnimationState(menu);
}

export function showMenuWithAnimation(menu) {
    if (!menu) return;

    clearHideAnimationState(menu);
    menu.classList.remove('hiding');
    menu.classList.add('visible');
}

export function hideMenuWithAnimation(menu) {
    if (!menu) return;

    if (menu.classList.contains('hiding')) return;
    if (!menu.classList.contains('visible')) {
        menu.classList.remove('hiding');
        clearHideAnimationState(menu);
        return;
    }

    menu.classList.remove('visible');
    menu.classList.add('hiding');

    const onAnimationEnd = (event) => {
        if (event.target !== menu) return;
        if (event.animationName !== MENU_HIDE_ANIMATION_NAME) return;
        finalizeHide(menu);
    };
    const hideDurationMs = getHideAnimationDurationMs(menu);
    const timerId = setTimeout(finalizeHide, hideDurationMs + HIDE_FALLBACK_BUFFER_MS, menu);

    menuAnimationState.set(menu, { timerId, onAnimationEnd });
    menu.addEventListener('animationend', onAnimationEnd);
}
