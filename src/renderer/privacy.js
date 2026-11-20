'use strict';
// Deliberate invitation display is the only secret crossing into this UI.
window.PrivateSettings = (() => {
  let api;
  let state;
  let awaiting = false;
  const el = id => document.getElementById(id);
  function update(status) {
    state = status;
    if (!status) return;
    awaiting = !!status.enrolling;
    const paired = status.paired;
    const role = status.role;
    el('private-status').textContent = !status.available ? status.error
      : paired ? `${status.peer.name} · ${status.online ? 'conexão privada ativa' : 'aguardando conexão privada'}`
      : status.pending.length ? 'Um dispositivo pediu acesso. Confira a identidade com seu amigo antes de autorizar.'
      : awaiting ? 'Convite enviado. Aguarde a aprovação no computador do criador.'
      : role === 'owner' ? 'Espaço privado criado. O histórico já está reservado; falta autorizar o segundo dispositivo.'
      : 'O histórico anterior está reservado. Crie um espaço privado ou aceite o convite do seu amigo.';
    el('private-identity').textContent = status.fingerprint ? `Sua identidade: ${status.fingerprint.match(/.{1,8}/g).join(' ')}` : '';
    el('private-create').hidden = paired || role === 'member' || awaiting;
    el('private-create').disabled = !status.available;
    el('private-accept').hidden = role !== 'none' || awaiting;
    el('private-accept').disabled = !status.available;
    el('private-revoke').hidden = role === 'none' && !awaiting;
    el('private-revoke').textContent = role === 'member' || awaiting ? 'Desconectar espaço privado' : 'Revogar acesso / cancelar convite';
    if (paired) { awaiting = false; el('private-code').value = ''; }
    const pending = el('private-pending');
    pending.replaceChildren();
    for (const candidate of status.pending) {
      const row = document.createElement('div');
      const text = document.createElement('p');
      text.textContent = `${candidate.name} · ${candidate.address}\nIdentidade: ${candidate.fingerprint.match(/.{1,8}/g).join(' ')}`;
      text.className = 'private-fingerprint';
      const approve = document.createElement('button');
      approve.type = 'button'; approve.className = 'pill-btn'; approve.textContent = 'Autorizar este dispositivo';
      approve.onclick = () => run(approve, () => api.approvePrivateDevice(candidate.fingerprint));
      row.append(text, approve); pending.append(row);
    }
  }
  async function run(button, action) {
    button.disabled = true;
    el('private-error').textContent = '';
    try { await action(); update(await api.privacyStatus()); }
    catch (err) { el('private-error').textContent = String(err.message || err).replace(/^.*Error: /, ''); }
    finally { button.disabled = false; }
  }
  function init(bridge, status) {
    api = bridge;
    el('private-create').onclick = () => run(el('private-create'), async () => {
      el('private-code').value = await api.createPrivateInvite();
      el('private-code').focus(); el('private-code').select();
    });
    el('private-copy').onclick = () => run(el('private-copy'), async () => {
      if (!el('private-code').value.trim()) throw new Error('Gere ou cole um convite primeiro.');
      await navigator.clipboard.writeText(el('private-code').value.trim());
      el('private-status').textContent = 'Convite copiado. Envie apenas para seu amigo, por uma conversa privada.';
    });
    el('private-accept').onclick = () => run(el('private-accept'), async () => {
      const code = el('private-code').value.trim();
      if (!code) { el('private-code').focus(); throw new Error('Cole o convite do seu amigo.'); }
      await api.acceptPrivateInvite(code);
      awaiting = true; el('private-code').value = '';
    });
    el('private-revoke').onclick = () => run(el('private-revoke'), async () => {
      await api.revokePrivateDevice(); awaiting = false; el('private-code').value = '';
    });
    el('dlg-settings').addEventListener('close', () => { el('private-code').value = ''; });
    update(status);
  }
  return { init, update };
})();
