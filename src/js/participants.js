// Participantes del viaje y estado de envío de su respuesta.
function renderParticipants() {
  const host = $('participants-list');
  if (!host) return;

  const submitted = new Set((respuestas || []).map(r => String(r.nombre || '').toLocaleLowerCase()));
  const names = new Map();
  (respondentes || []).forEach(r => {
    if (r && r.nombre) names.set(String(r.nombre).toLocaleLowerCase(), String(r.nombre));
  });
  (respuestas || []).forEach(r => {
    if (r && r.nombre) names.set(String(r.nombre).toLocaleLowerCase(), String(r.nombre));
  });
  if (user?.nombre) names.set(user.nombre.toLocaleLowerCase(), user.nombre);

  const people = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  if (!people.length) {
    host.innerHTML = '<p class="participants-empty">Aún no hay participantes.</p>';
    return;
  }

  host.innerHTML = people.map(([key, name]) => {
    const voted = submitted.has(key);
    const own = user && key === user.nombre.toLocaleLowerCase();
    return `<div class="participant-row">
      <span class="participant-name">${esc(name)}${own ? ' <span class="participant-you">(tú)</span>' : ''}</span>
      <span class="participant-vote ${voted ? 'is-voter' : 'not-voter'}"><i class="fa-solid ${voted ? 'fa-circle-check' : 'fa-clock'}" aria-hidden="true"></i> ${voted ? 'Ha votado' : 'Pendiente'}</span>
      <button type="button" class="participant-delete" data-participant="${esc(name)}" ${own ? 'data-own="1"' : ''} aria-label="Eliminar a ${esc(name)}" title="${own ? 'Eliminar tu participación' : 'Eliminar participante'}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
    </div>`;
  }).join('');

  host.querySelectorAll('.participant-delete').forEach(btn => btn.addEventListener('click', async () => {
    const name = btn.dataset.participant;
    if (!user || !name) return;
    const own = btn.dataset.own === '1';
    if (!own) {
      showStatus('La base de datos aún no tiene roles de administración para autorizar la eliminación de otros participantes.', 'err', 6000);
      return;
    }
    if (!window.confirm('¿Eliminar tu participación? Se borrarán tus respuestas y actividad del viaje.')) return;
    btn.disabled = true;
    try {
      await apiAuth({ action: 'delete_participant', eid: user.eid, nombre: user.nombre, pinHash: user.pinHash, participant: name });
      logout();
    } catch (e) {
      btn.disabled = false;
      showStatus('No se pudo eliminar al participante: ' + e.message, 'err', 8000);
    }
  }));
}

