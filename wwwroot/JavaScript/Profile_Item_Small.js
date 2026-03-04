/**
 * Universal small profile list item — fd-profile-item-small design.
 * Used by: Media Library → Image → Players,
 *          Timeline → Instances/Images → Players in Instance,
 *          Timeline → Friends → Was also here.
 *
 * @param {object} user    - { id|userId, displayName, image, subtitle? }
 * @param {string} onclick - Inline JS onclick string (empty = not clickable)
 * @returns {string} HTML string
 */
function renderProfileItemSmall(user, onclick) {
    const id   = user.id || user.userId || '';
    const name = user.displayName || '?';

    // Prefer live friend image
    const live  = id ? vrcFriendsData.find(f => f.id === id) : null;
    const image = live?.image || user.image || '';

    const av = image
        ? `<div class="fd-pi-sm-av" style="background-image:url('${cssUrl(image)}')"></div>`
        : `<div class="fd-pi-sm-av fd-pi-sm-av-letter">${esc(name[0].toUpperCase())}</div>`;

    const badge = live ? '<span class="fd-pi-sm-badge">Friend</span>' : '';
    const sub   = user.subtitle ? `<div class="fd-pi-sm-sub">${esc(user.subtitle)}</div>` : '';
    const clickAttr = onclick ? ` onclick="${onclick}"` : '';
    const cursorStyle = onclick ? ' style="cursor:pointer;"' : '';

    return `<div class="fd-profile-item-small"${clickAttr}${cursorStyle}>${av}<div class="fd-pi-sm-info"><div class="fd-pi-sm-name">${esc(name)}${badge}</div>${sub}</div></div>`;
}
