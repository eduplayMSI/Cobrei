// ========================== COBREI? PWA ==========================
// Versão com limites completos por plano (Free, Pro, Team)

const DB_NAME = 'CobreiDB';
const DB_VERSION = 4;        // nova versão para adicionar store 'usage'
let dbInstance = null;
let currentUserPlan = 'free';
const planLimits = {
  free: { maxClients: 10, maxActiveCharges: 20, maxRecurringCharges: 3, maxExportsPerMonth: 5, historyMonths: 6, maxImportPerBatch: 10 },
  pro: { maxClients: Infinity, maxActiveCharges: Infinity, maxRecurringCharges: Infinity, maxExportsPerMonth: Infinity, historyMonths: 24, maxImportPerBatch: Infinity },
  team: { maxClients: Infinity, maxActiveCharges: Infinity, maxRecurringCharges: Infinity, maxExportsPerMonth: Infinity, historyMonths: Infinity, maxImportPerBatch: Infinity }
};
let activeView = 'dashboard';

// -------- HELPERS ----------
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerText = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// -------- INDEXEDDB (inicialização com nova store 'usage') ----------
function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      dbInstance = request.result;
      resolve();
    };
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('clientes')) {
        const store = db.createObjectStore('clientes', { keyPath: 'id', autoIncrement: true });
        store.createIndex('nome', 'nome');
      }
      if (!db.objectStoreNames.contains('cobrancas')) {
        const store = db.createObjectStore('cobrancas', { keyPath: 'id', autoIncrement: true });
        store.createIndex('clienteId', 'clienteId');
        store.createIndex('status', 'status');
        store.createIndex('vencimento', 'vencimento');
      }
      if (!db.objectStoreNames.contains('configuracoes')) {
        db.createObjectStore('configuracoes', { keyPath: 'chave' });
      }
      if (!db.objectStoreNames.contains('logs')) {
        db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('mensagens')) {
        const msgStore = db.createObjectStore('mensagens', { keyPath: 'id', autoIncrement: true });
        msgStore.add({ nome: 'Cordial', texto: 'Olá {cliente}, tudo bem? O pagamento de R$ {valor} referente a {vencimento} está em aberto. Pode ser pago via PIX? Agradeço!' });
        msgStore.add({ nome: 'Firme', texto: 'Prezado {cliente}, o pagamento de R$ {valor} venceu em {vencimento}. Necessitamos regularização imediata.' });
        msgStore.add({ nome: 'Final', texto: '{cliente}, por favor, regularize o pagamento de R$ {valor} até amanhã para evitar interrupção do serviço.' });
      }
      if (!db.objectStoreNames.contains('usage')) {
        db.createObjectStore('usage', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function getStore(storeName, mode = 'readonly') {
  if (!dbInstance) await initDatabase();
  return dbInstance.transaction(storeName, mode).objectStore(storeName);
}

async function getAll(storeName, filterFn = null) {
  const store = await getStore(storeName);
  return new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => {
      let results = req.result || [];
      if (filterFn) results = results.filter(filterFn);
      resolve(results);
    };
  });
}

async function saveItem(storeName, item) {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteItem(storeName, id) {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((resolve) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
  });
}

// -------- CONTROLE DE EXPORTAÇÕES MENSAIS (Free) ----------
async function checkAndIncrementExport() {
  if (currentUserPlan !== 'free') return true; // Pro/Team sem limite
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${now.getMonth()+1}`;
  const store = await getStore('usage', 'readwrite');
  const all = await new Promise(resolve => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
  });
  let registro = all.find(r => r.key === `export_${yearMonth}`);
  if (!registro) {
    registro = { key: `export_${yearMonth}`, count: 0 };
  }
  if (registro.count >= planLimits.free.maxExportsPerMonth) {
    showToast(`Limite de ${planLimits.free.maxExportsPerMonth} exportações mensais atingido. Faça upgrade para Pro.`, 'warning');
    return false;
  }
  registro.count++;
  await saveItem('usage', registro);
  return true;
}

// -------- FILTRO DE HISTÓRICO POR PLANO ----------
function filtrarPorHistorico(cobrancas) {
  const months = planLimits[currentUserPlan].historyMonths;
  if (months === Infinity) return cobrancas;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return cobrancas.filter(c => new Date(c.vencimento) >= cutoff);
}

// -------- VERIFICAÇÃO DE LIMITE DE COBRANÇAS ATIVAS ----------
async function checkActiveChargesLimit() {
  if (currentUserPlan !== 'free') return true;
  const todas = await listarCobrancas();
  const ativas = todas.filter(c => c.status !== 'paga');
  if (ativas.length >= planLimits.free.maxActiveCharges) {
    showToast(`Limite de ${planLimits.free.maxActiveCharges} cobranças ativas atingido.`, 'warning');
    return false;
  }
  return true;
}

// -------- VERIFICAÇÃO DE LIMITE DE COBRANÇAS RECORRENTES ----------
async function checkRecurringLimit() {
  if (currentUserPlan !== 'free') return true;
  const todas = await listarCobrancas();
  const recorrentesAtivas = todas.filter(c => c.recorrencia && c.recorrencia !== 'nenhum' && c.status !== 'paga');
  if (recorrentesAtivas.length >= planLimits.free.maxRecurringCharges) {
    showToast(`Plano Free permite no máximo ${planLimits.free.maxRecurringCharges} cobranças recorrentes ativas.`, 'warning');
    return false;
  }
  return true;
}

// -------- CONFIGURAÇÕES INICIAIS ----------
async function loadConfig() {
  const store = await getStore('configuracoes');
  const themeReq = store.get('tema');
  themeReq.onsuccess = () => {
    const theme = themeReq.result?.valor || 'light';
    if (theme === 'dark') document.body.classList.add('dark');
  };
  const planReq = store.get('plano');
  planReq.onsuccess = () => {
    currentUserPlan = planReq.result?.valor || 'free';
    document.getElementById('planBadge').innerText = currentUserPlan.toUpperCase();
    
    // ========== CONTROLE DA BARRA PROMOCIONAL ==========
    const promoBar = document.getElementById('promoBar');
    if (promoBar) {
      if (currentUserPlan === 'free') {
        promoBar.classList.add('show');
      } else {
        promoBar.classList.remove('show');
      }
    }
    // =================================================
  };
}

async function setConfig(chave, valor) {
  const store = await getStore('configuracoes', 'readwrite');
  store.put({ chave, valor });
}

// -------- CRUD CLIENTES ----------
async function listarClientes() { return getAll('clientes'); }
async function salvarCliente(cliente) {
  if (cliente.id === undefined) delete cliente.id;
  return saveItem('clientes', cliente);
}
async function excluirCliente(id) { return deleteItem('clientes', id); }

async function listarCobrancas() { 
  const todas = await getAll('cobrancas');
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  let atualizadas = false;
  const novas = todas.map(c => {
    if (c.status !== 'paga') {
      const vencimentoDate = new Date(c.vencimento);
      vencimentoDate.setHours(0, 0, 0, 0);
      if (vencimentoDate < hoje) {
        if (c.status !== 'atrasada') atualizadas = true;
        return { ...c, status: 'atrasada' };
      } else if (c.status === 'atrasada') {
        // Se não está mais atrasada (data editada), volta para pendente
        if (vencimentoDate >= hoje) {
          atualizadas = true;
          return { ...c, status: 'pendente' };
        }
      }
    }
    return c;
  });
  if (atualizadas) {
    // Salva as alterações em lote (simplificado)
    for (const cob of novas) {
      const original = todas.find(t => t.id === cob.id);
      if (original && JSON.stringify(cob) !== JSON.stringify(original)) {
        await salvarCobranca(cob);
      }
    }
  }
  return filtrarPorHistorico(novas);
}
async function salvarCobranca(cobranca) {
  if (cobranca.id === undefined) delete cobranca.id;
  // Garantir campo createdAt para histórico
  if (!cobranca.createdAt) cobranca.createdAt = new Date().toISOString();
  return saveItem('cobrancas', cobranca);
}
async function excluirCobranca(id) { return deleteItem('cobrancas', id); }

async function listarMensagens() { return getAll('mensagens'); }

// -------- PROCESSAR PAGAMENTO E RECORRÊNCIA ----------
async function processarPagamentoCobranca(id) {
  const cobrancas = await listarCobrancas();
  const cob = cobrancas.find(c => c.id === id);
  if (!cob) return;
  cob.status = 'paga';
  await salvarCobranca(cob);
  if (cob.recorrencia && cob.recorrencia !== 'nenhum') {
    let newDate = new Date(cob.vencimento);
    if (cob.recorrencia === 'mensal') newDate.setMonth(newDate.getMonth() + 1);
    else if (cob.recorrencia === 'quinzenal') newDate.setDate(newDate.getDate() + 15);
    else if (cob.recorrencia === 'semanal') newDate.setDate(newDate.getDate() + 7);
    const novaCob = {
      ...cob,
      id: undefined,
      vencimento: newDate.toISOString().slice(0, 10),
      status: 'pendente',
      notifiedToday: false,
      notifiedOverdue: false,
      createdAt: new Date().toISOString()
    };
    await salvarCobranca(novaCob);
    showToast(`Nova cobrança recorrente gerada para ${newDate.toLocaleDateString()}`);
  }
  renderView(activeView);
}

// -------- DASHBOARD (sem alterações visuais) ----------
async function renderDashboard() {
  const clientes = await listarClientes();
  const cobrancas = await listarCobrancas();
  const now = new Date();
  const vencidas = cobrancas.filter(c => new Date(c.vencimento) < now && c.status !== 'paga');
  const hoje = cobrancas.filter(c => c.vencimento === new Date().toISOString().split('T')[0] && c.status !== 'paga');
  const pagas = cobrancas.filter(c => c.status === 'paga');
  const totalRecebido = pagas.reduce((s, c) => s + Number(c.valor), 0);
  const previsto = cobrancas.filter(c => c.status !== 'paga').reduce((s, c) => s + Number(c.valor), 0);

  // Verifica se há configuração de ocultar valor. Se não existir, define como true (oculto)
  let hideRecebido = await getConfig('hideRecebido');
  if (hideRecebido === null) {
    hideRecebido = true;
    await setConfig('hideRecebido', true);
  } else {
    hideRecebido = hideRecebido === true || hideRecebido === 'true';
  }

  return `
    <div class="grid-cards">
      <div class="stat-card">⚠️ Vencidas: ${vencidas.length}</div>
      <div class="stat-card">📅 Do dia: ${hoje.length}</div>
      <div class="stat-card" style="display: flex; align-items: center; gap: 8px;">
        <span>💰 Recebido:</span>
        <span id="recebidoValor">${hideRecebido ? '••••' : `R$ ${totalRecebido.toFixed(2)}`}</span>
        <button id="toggleRecebidoBtn" class="btn-outline" style="padding: 2px 8px; line-height: 1;">👁️</button>
      </div>
      <div class="stat-card">📊 Previsto: R$ ${previsto.toFixed(2)}</div>
      <div class="stat-card">👥 Clientes ativos: ${clientes.length}</div>
    </div>
    <div class="card" id="carrosselContainer">
      <h3>Alertas prioritários</h3>
      <div id="carrosselAlerta" style="text-align: center; min-height: 60px; padding: 10px; background: #f8f9fa; border-radius: 8px; overflow: hidden; position: relative;">
        ${vencidas.length === 0 ? '<span>✅ Nenhum alerta no momento</span>' : ''}
      </div>
    </div>
  `;
}

let intervaloCarrossel = null;

function iniciarCarrossel(alertas) {
  const container = document.getElementById('carrosselAlerta');
  if (!container) return;
  if (intervaloCarrossel) clearInterval(intervaloCarrossel);
  
  if (alertas.length === 0) {
    container.innerHTML = '<span>✅ Nenhum alerta no momento</span>';
    return;
  }

  // Estiliza o container
  container.style.overflow = 'hidden';
  container.style.position = 'relative';
  container.style.height = '60px';

  let index = 0;
  let currentItem = null;
  let timeoutId = null;

  // Função para criar um elemento de alerta
  const criarItem = (alerta) => {
    const texto = `⚠️ ${alerta.clienteNome} - R$ ${alerta.valor} venceu em ${alerta.vencimento}`;
    const div = document.createElement('div');
    div.className = 'carrossel-item';
    div.innerText = texto;
    div.style.cssText = `
      position: absolute;
      width: 100%;
      text-align: center;
      padding: 10px;
      left: 0;
      top: 100%;
      opacity: 0;
      transition: all 0.5s ease-out;
      font-weight: 500;
      background: #f8f9fa;
      border-radius: 8px;
    `;
    return div;
  };

  // Função para mostrar um alerta (animação de entrada)
  const mostrarAlerta = (alerta) => {
    const novoItem = criarItem(alerta);
    container.appendChild(novoItem);
    
    // Força reflow para a animação funcionar
    novoItem.offsetHeight;
    novoItem.style.top = '0';
    novoItem.style.opacity = '1';
    
    return novoItem;
  };

  // Função para esconder o item atual (animação de saída) e chamar o próximo
  const esconderAtualEProximo = () => {
    if (currentItem) {
      currentItem.style.top = '-100%';
      currentItem.style.opacity = '0';
      // Aguarda a animação terminar antes de remover
      setTimeout(() => {
        if (currentItem && currentItem.parentNode) currentItem.remove();
      }, 500);
    }
    // Avança para o próximo índice
    index = (index + 1) % alertas.length;
    // Mostra o próximo após um pequeno delay (para a animação de saída)
    timeoutId = setTimeout(() => {
      currentItem = mostrarAlerta(alertas[index]);
      // Agenda a próxima troca após 5 segundos
      timeoutId = setTimeout(esconderAtualEProximo, 5000);
    }, 500);
  };

  // Inicia com o primeiro alerta
  currentItem = mostrarAlerta(alertas[0]);
  // Agenda a primeira troca após 5 segundos
  timeoutId = setTimeout(esconderAtualEProximo, 5000);

  // Armazena o timeout para limpeza posterior
  window.carrosselTimeout = timeoutId;
}

// -------- CLIENTES (sem alterações visuais) ----------
async function renderClientes() {
  const clientes = await listarClientes();
  let html = `<div class="card"><div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;"><h2>Clientes</h2><div style="display:flex; gap:0.5rem;"><button class="btn" id="novoClienteBtn">+ Novo</button><button class="btn" id="importarContatosBtn">📇 Importar contatos</button></div></div></div><div class="card"><table style="width:100%"><thead><tr><th>Nome</th><th>Telefone</th><th>Categoria</th><th>Ações</th></tr></thead><tbody>`;
  clientes.forEach(c => {
    html += `<tr><td>${c.nome}</td><td>${c.telefone || ''}</td><td>${c.categoria || ''}</td><td><button data-id="${c.id}" class="editCliente btn-outline">✏️</button> <button data-id="${c.id}" class="delCliente btn-outline">🗑️</button></td></tr>`;
  });
  html += `</tbody></table></div>`;
  return html;
}

function abrirModalCliente(cliente = null) {
  if (!cliente) {
    (async () => {
      const clientesAtuais = await listarClientes();
      if (currentUserPlan === 'free' && clientesAtuais.length >= planLimits.free.maxClients) {
        showToast(`Plano Free permite no máximo ${planLimits.free.maxClients} clientes. Faça upgrade.`, 'warning');
        return;
      }
      criarModalCliente(cliente);
    })();
  } else {
    criarModalCliente(cliente);
  }
}

function criarModalCliente(cliente = null) {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>${cliente ? 'Editar Cliente' : 'Novo Cliente'}</h3>
      <input type="text" id="clienteNome" placeholder="Nome" value="${cliente ? cliente.nome : ''}" style="width:100%; margin:8px 0; padding:8px">
      <input type="tel" id="clienteTelefone" placeholder="Telefone (ex: 11999999999)" value="${cliente ? cliente.telefone : ''}" style="width:100%; margin:8px 0; padding:8px">
      <input type="email" id="clienteEmail" placeholder="E-mail" value="${cliente ? cliente.email : ''}" style="width:100%; margin:8px 0; padding:8px">
      <input type="text" id="clienteCategoria" placeholder="Categoria" value="${cliente ? cliente.categoria : ''}" style="width:100%; margin:8px 0; padding:8px">
      <textarea id="clienteObs" placeholder="Observações" style="width:100%; margin:8px 0; padding:8px">${cliente ? cliente.observacoes : ''}</textarea>
      <div style="display:flex; gap:8px; justify-content:flex-end">
        <button class="btn-outline" id="modalCancelar">Cancelar</button>
        <button class="btn" id="modalSalvar">Salvar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const telefoneInput = document.getElementById('clienteTelefone');
  telefoneInput.addEventListener('input', function(e) {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length > 11) value = value.slice(0, 11);
    e.target.value = value;
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.getElementById('modalCancelar').onclick = () => modal.remove();
  document.getElementById('modalSalvar').onclick = async () => {
    const nome = document.getElementById('clienteNome').value.trim();
    if (!nome) { showToast('Nome é obrigatório', 'warning'); return; }
    let telefoneRaw = document.getElementById('clienteTelefone').value.trim();
    let telefoneFormatado = telefoneRaw ? formatPhoneToBrazil(telefoneRaw) : '';
    const clienteData = {
      nome, telefone: telefoneFormatado, email: document.getElementById('clienteEmail').value,
      categoria: document.getElementById('clienteCategoria').value,
      observacoes: document.getElementById('clienteObs').value, status: 'ativo'
    };
    if (cliente && cliente.id) clienteData.id = cliente.id;
    else {
      const clientesAtuais = await listarClientes();
      if (currentUserPlan === 'free' && clientesAtuais.length >= planLimits.free.maxClients) {
        showToast(`Limite de clientes atingido (${planLimits.free.maxClients}).`, 'warning');
        modal.remove(); return;
      }
    }
    try {
      await salvarCliente(clienteData);
      modal.remove();
      await renderView('clientes');
      showToast('Cliente salvo!', 'success');
    } catch (error) { showToast('Erro ao salvar.', 'error'); }
  };
}

// -------- COBRANÇAS (com verificações de limites) ----------
async function renderCobrancas() {
  const cobrancas = await listarCobrancas();
  let html = `<div class="card"><button class="btn" id="novaCobrancaBtn">+ Nova Cobrança</button></div><div class="card"><table style="width:100%"><thead><tr><th>Cliente</th><th>Valor</th><th>Vencimento</th><th>Status</th><th>Ações</th></tr></thead><tbody>`;
  for (let c of cobrancas) {
    html += `<tr><td>${c.clienteNome}</td><td>R$ ${c.valor}</td><td>${c.vencimento}</td><td><span class="status ${c.status}">${c.status}</span></td><td><button data-id="${c.id}" class="pagarCobranca btn-outline">✅ Pagar</button> <button data-id="${c.id}" class="delCobranca btn-outline">🗑️</button></td></tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

async function abrirModalCobranca(cobranca = null) {
  const clientes = await listarClientes();
  if (clientes.length === 0) { showToast('Cadastre um cliente primeiro'); return; }

  // Verificar limite de cobranças ativas antes de abrir modal (se for nova)
  if (!cobranca && !(await checkActiveChargesLimit())) return;

  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:600px;">
      <h3>${cobranca ? 'Editar Cobrança' : 'Nova Cobrança'}</h3>
      <div style="margin: 12px 0;">
        <label style="margin-right: 20px;"><input type="radio" name="tipoCobranca" value="individual" checked> Individual</label>
        <label><input type="radio" name="tipoCobranca" value="grupo"> Em Grupo</label>
      </div>
      <div id="clienteSelecaoArea">
        <select id="cobrancaClienteId" style="width:100%; margin:8px 0; padding:8px">
          <option value="">Selecione um cliente</option>
          ${clientes.map(c => `<option value="${c.id}" ${cobranca && cobranca.clienteId == c.id ? 'selected' : ''}>${c.nome}</option>`).join('')}
        </select>
      </div>
      <input type="number" id="cobrancaValor" placeholder="Valor (R$)" value="${cobranca ? cobranca.valor : ''}" style="width:100%; margin:8px 0; padding:8px">
      <input type="date" id="cobrancaVencimento" value="${cobranca ? cobranca.vencimento : ''}" style="width:100%; margin:8px 0; padding:8px">
      <select id="cobrancaRecorrencia" style="width:100%; margin:8px 0; padding:8px">
        <option value="nenhum" ${cobranca && cobranca.recorrencia === 'nenhum' ? 'selected' : ''}>Sem recorrência</option>
        <option value="semanal" ${cobranca && cobranca.recorrencia === 'semanal' ? 'selected' : ''}>Semanal</option>
        <option value="quinzenal" ${cobranca && cobranca.recorrencia === 'quinzenal' ? 'selected' : ''}>Quinzenal</option>
        <option value="mensal" ${cobranca && cobranca.recorrencia === 'mensal' ? 'selected' : ''}>Mensal</option>
      </select>
      <textarea id="cobrancaObs" placeholder="Observações" style="width:100%; margin:8px 0; padding:8px">${cobranca ? cobranca.observacoes : ''}</textarea>
      <div style="display:flex; gap:8px; justify-content:flex-end">
        <button class="btn-outline" id="modalCancelar">Cancelar</button>
        <button class="btn" id="modalSalvar">Salvar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  const radioIndividual = modal.querySelector('input[value="individual"]');
  const radioGrupo = modal.querySelector('input[value="grupo"]');
  const clienteArea = modal.querySelector('#clienteSelecaoArea');

  function atualizarSelecaoClientes() {
    if (radioGrupo.checked) {
      let html = '<div style="margin:8px 0; max-height:200px; overflow-y:auto; border:1px solid #ccc; padding:8px; border-radius:8px;"><strong>Selecione os clientes:</strong><br>';
      clientes.forEach(c => { html += `<label style="display:block; margin:5px 0;"><input type="checkbox" value="${c.id}"> ${c.nome}</label>`; });
      html += '</div>';
      clienteArea.innerHTML = html;
    } else {
      let options = '<select id="cobrancaClienteId" style="width:100%; margin:8px 0; padding:8px"><option value="">Selecione um cliente</option>';
      clientes.forEach(c => { options += `<option value="${c.id}">${c.nome}</option>`; });
      options += '</select>';
      clienteArea.innerHTML = options;
    }
  }
  radioIndividual.addEventListener('change', atualizarSelecaoClientes);
  radioGrupo.addEventListener('change', atualizarSelecaoClientes);
  atualizarSelecaoClientes();

  document.getElementById('modalCancelar').onclick = () => modal.remove();

  document.getElementById('modalSalvar').onclick = async () => {
    const valor = parseFloat(document.getElementById('cobrancaValor').value);
    if (isNaN(valor)) return showToast('Valor inválido');
    const vencimento = document.getElementById('cobrancaVencimento').value;
    if (!vencimento) return showToast('Data de vencimento obrigatória');
    const recorrencia = document.getElementById('cobrancaRecorrencia').value;
    const observacoes = document.getElementById('cobrancaObs').value;

    // Verificar limite de recorrentes se for Free e recorrente
    if (currentUserPlan === 'free' && recorrencia !== 'nenhum') {
      if (!(await checkRecurringLimit())) return;
    }

    if (radioIndividual.checked) {
      const clienteSelect = modal.querySelector('#cobrancaClienteId');
      const clienteId = parseInt(clienteSelect.value);
      if (!clienteId) return showToast('Selecione um cliente');
      const cliente = clientes.find(c => c.id === clienteId);
      const novaCob = {
        clienteId: cliente.id, clienteNome: cliente.nome, valor, vencimento,
        status: 'pendente', recorrencia, observacoes,
        notifiedToday: false, notifiedOverdue: false, createdAt: new Date().toISOString()
      };
      await salvarCobranca(novaCob);
      showToast(`Cobrança para ${cliente.nome} salva!`);
    } else {
      const checkboxes = modal.querySelectorAll('#clienteSelecaoArea input[type="checkbox"]:checked');
      if (checkboxes.length === 0) return showToast('Selecione pelo menos um cliente');
      let criadas = 0;
      for (const cb of checkboxes) {
        const clienteId = parseInt(cb.value);
        const cliente = clientes.find(c => c.id === clienteId);
        await salvarCobranca({
          clienteId: cliente.id, clienteNome: cliente.nome, valor, vencimento,
          status: 'pendente', recorrencia, observacoes,
          notifiedToday: false, notifiedOverdue: false, createdAt: new Date().toISOString()
        });
        criadas++;
      }
      showToast(`${criadas} cobrança(s) criada(s) em grupo.`);
    }
    modal.remove();
    renderView('cobrancas');
  };
}

// -------- MENSAGENS (com bloqueio free já existente) ----------
async function renderMensagens() {
  const msgs = await listarMensagens();
  let html = `<div class="card"><h2>Mensagens prontas</h2>`;
  if (currentUserPlan !== 'free') html += `<button id="addMsgBtn" class="btn">+ Novo modelo</button>`;
  else html += `<p style="color: #DD6B20;">🔒 Plano Free não permite criar novos modelos. Faça upgrade para Pro.</p>`;
  html += `</div>`;
  for (let m of msgs) {
    html += `<div class="card"><h3>${m.nome}</h3><p>${m.texto}</p><button data-text="${m.texto.replace(/['"]/g, '&quot;')}" class="copyMsgBtn">📋 Copiar</button> <button data-whats="${m.texto.replace(/[\n]/g, ' ')}" class="whatsMsgBtn">📱 WhatsApp</button> <button data-id="${m.id}" class="delMsgBtn">🗑️</button></div>`;
  }
  return html;
}

// -------- RELATÓRIOS (com controle de exportação) ----------
async function renderRelatorios() {
  const cobrancas = await listarCobrancas();
  const totalCobrado = cobrancas.reduce((s, c) => s + Number(c.valor), 0);
  const totalRecebido = cobrancas.filter(c => c.status === 'paga').reduce((s, c) => s + Number(c.valor), 0);
  const emAberto = totalCobrado - totalRecebido;
  const atraso = cobrancas.filter(c => c.status === 'atrasada' || (new Date(c.vencimento) < new Date() && c.status !== 'paga')).length;
  const taxaAtraso = cobrancas.length ? (atraso / cobrancas.length * 100).toFixed(1) : 0;
  return `
    <div class="grid-cards">
      <div class="stat-card">💰 Total cobrado: R$ ${totalCobrado.toFixed(2)}</div>
      <div class="stat-card">✅ Recebido: R$ ${totalRecebido.toFixed(2)}</div>
      <div class="stat-card">📉 Em aberto: R$ ${emAberto.toFixed(2)}</div>
      <div class="stat-card">⏰ Taxa atraso: ${taxaAtraso}%</div>
    </div>
    <div class="card"><h3>📊 Evolução de recebimentos</h3><canvas id="graficoRecebimentos" width="400" height="200" style="max-width:100%; height:auto;"></canvas></div>
    <div class="card"><h3>📋 Lista de cobranças por status</h3>
      <div style="display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:1rem;">
        <button id="filtroTodas" class="btn-outline">Todas</button>
        <button id="filtroPendentes" class="btn-outline">Pendentes</button>
        <button id="filtroPagas" class="btn-outline">Pagas</button>
      </div>
      <div id="tabelaDinamica" style="overflow-x:auto;">${gerarTabelaCobrancas(cobrancas, 'todas')}</div>
    </div>
    <div class="card" style="display: flex; gap: 1rem;">
      <button class="btn" id="exportarCSV">📁 Exportar CSV</button>
      <button class="btn" id="exportarPDF">🖨️ Exportar PDF</button>
    </div>
  `;
}

function gerarTabelaCobrancas(cobrancas, filtro = 'todas') {
  let lista = cobrancas;
  if (filtro === 'pendentes') lista = cobrancas.filter(c => c.status !== 'paga');
  if (filtro === 'pagas') lista = cobrancas.filter(c => c.status === 'paga');
  if (lista.length === 0) return '<p>Nenhuma cobrança encontrada.</p>';
  return `<table style="width:100%; border-collapse:collapse;"><thead><tr><th>Cliente</th><th>Valor</th><th>Vencimento</th><th>Status</th></tr></thead><tbody>${lista.map(c => `<tr><td>${c.clienteNome}</td><td>R$ ${c.valor}</td><td>${c.vencimento}</td><td>${c.status}</td></tr>`).join('')}</tbody></table>`;
}

async function exportarCSV() {
  if (!(await checkAndIncrementExport())) return;
  const cobrancas = await listarCobrancas();
  const linhas = [['ID', 'Cliente', 'Valor', 'Vencimento', 'Status', 'FormaPagamento']];
  cobrancas.forEach(c => linhas.push([c.id, c.clienteNome, c.valor, c.vencimento, c.status, c.formaPagamento || '']));
  const csv = linhas.map(row => row.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cobrei_relatorio_${new Date().toISOString()}.csv`;
  a.click();
  showToast('Exportado com sucesso!');
}

async function exportarPDF() {
  if (!(await checkAndIncrementExport())) return;
  const cobrancas = await listarCobrancas();
  const totalCobrado = cobrancas.reduce((s, c) => s + Number(c.valor), 0);
  const totalRecebido = cobrancas.filter(c => c.status === 'paga').reduce((s, c) => s + Number(c.valor), 0);
  const emAberto = totalCobrado - totalRecebido;
  const atraso = cobrancas.filter(c => c.status === 'atrasada' || (new Date(c.vencimento) < new Date() && c.status !== 'paga')).length;
  const taxaAtraso = cobrancas.length ? (atraso / cobrancas.length * 100).toFixed(1) : 0;
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html><head><title>Relatório Cobrei? - ${new Date().toLocaleDateString()}</title>
    <style>body{font-family:system-ui;margin:2rem;}h1{color:#1E3A5F;}.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin:2rem 0;}.card{background:#f5f5f5;padding:1rem;border-radius:12px;}table{width:100%;border-collapse:collapse;margin-top:1rem;}th,td{text-align:left;padding:0.5rem;border-bottom:1px solid #ccc;}th{background:#1E3A5F;color:white;}</style>
    </head><body>
    <h1>📊 Relatório Cobrei?</h1><p>Gerado em: ${new Date().toLocaleString()}</p>
    <div class="stats"><div class="card"><strong>💰 Total cobrado:</strong> R$ ${totalCobrado.toFixed(2)}</div><div class="card"><strong>✅ Total recebido:</strong> R$ ${totalRecebido.toFixed(2)}</div><div class="card"><strong>📉 Em aberto:</strong> R$ ${emAberto.toFixed(2)}</div><div class="card"><strong>⏰ Taxa de atraso:</strong> ${taxaAtraso}%</div></div>
    <h2>Lista de cobranças</h2><table><thead><tr><th>Cliente</th><th>Valor</th><th>Vencimento</th><th>Status</th></tr></thead><tbody>${cobrancas.map(c => `<tr><td>${c.clienteNome}</td><td>R$ ${c.valor}</td><td>${c.vencimento}</td><td>${c.status}</td></tr>`).join('')}</tbody></table>
    <footer><small>Cobrei? - Assistente de cobrança</small></footer></body></html>
  `);
  printWindow.document.close();
  printWindow.print();
}

// ========== SISTEMA DE ATIVAÇÃO POR CÓDIGO ==========

// Validação local (para testes iniciais)
async function validarCodigoLocal(codigo) {
  // Mapeamento de códigos -> plano (adicione quantos quiser)
  const codigos = {
    'PRO-FREE2025': 'pro',
    'TEAM-LANCAMENTO': 'team',
    'COBREI-PRO-ABC123': 'pro',
    'COBREI-TEAM-XYZ789': 'team'
  };
  const plano = codigos[codigo.toUpperCase()];
  if (plano) {
    currentUserPlan = plano;
    await setConfig('plano', plano);
     // Após ativar o plano, atualizar barra
   const promoBar = document.getElementById('promoBar');
   if (promoBar) promoBar.classList.remove('show');
    await setConfig('codigo_ativacao', codigo.toUpperCase());
    showToast(`Plano ${plano.toUpperCase()} ativado com sucesso!`, 'success');
    await renderView('configuracoes');
    return true;
  } else {
    showToast('Código inválido. Verifique e tente novamente.', 'error');
    return false;
  }
}

// Validação remota via Google Apps Script (substitua a URL pela sua depois)
async function validarCodigoRemoto(codigo) {
  try {
    const url = 'https://script.google.com/macros/s/AKfycbx4fSwgBMG3qTtBdyndXLv2xMTlUIQNIHEaorxqcjf-kjuqjov5r0sjkSMi4bJwyWlU5w/exec?codigo=' + encodeURIComponent(codigo);
    console.log('🌐 Validando com URL:', url);
    const response = await fetch(url);
    console.log('📡 Status HTTP:', response.status);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const textResponse = await response.text();
    console.log('📄 Resposta bruta:', textResponse);
    
    let data;
    try {
      data = JSON.parse(textResponse);
    } catch (e) {
      console.error('❌ JSON inválido:', e);
      showToast('Resposta inválida do servidor.', 'error');
      return false;
    }
    console.log('✅ Objeto parseado:', data);
    
    // Verifica se a resposta contém os campos esperados
    if (data.valido === true) {
      const plano = data.plano ? data.plano.toString().toLowerCase() : '';
      if (plano === 'pro' || plano === 'team') {
        currentUserPlan = plano;
        await setConfig('plano', plano);
        // Atualiza exibição da barra
   const promoBar = document.getElementById('promoBar');
   if (promoBar) {
   if (currentUserPlan === 'free') promoBar.classList.add('show');
   else promoBar.classList.remove('show');
}
        await setConfig('codigo_ativacao', codigo);
        showToast(`🎉 Plano ${plano.toUpperCase()} ativado com sucesso!`, 'success');
        await renderView('configuracoes');
        return true;
      } else {
        console.warn('⚠️ Plano retornado não é "pro" nem "team":', data.plano);
        showToast(`Código válido, mas plano "${data.plano}" não é suportado.`, 'error');
        return false;
      }
    } else {
      console.warn('⚠️ Código inválido ou já usado (valido = false)');
      showToast('Código inválido ou já utilizado.', 'error');
      return false;
    }
  } catch (err) {
    console.error('❌ Erro na validação remota:', err);
    showToast('Erro na validação: ' + err.message, 'error');
    return false;
  }
}

// -------- CONFIGURAÇÕES (sem alterações) ----------

async function getConfig(chave, padrao = null) {
  const store = await getStore('configuracoes');
  return new Promise((resolve) => {
    const req = store.get(chave);
    req.onsuccess = () => resolve(req.result ? req.result.valor : padrao);
    req.onerror = () => resolve(padrao);
  });
}

async function renderConfiguracoes() {
  try {
    let codigoAtivacao = '';
    try {
      codigoAtivacao = await getConfig('codigo_ativacao') || '';
    } catch(e) {
      console.warn('Erro ao obter código:', e);
      codigoAtivacao = '';
    }
    return `
      <div class="card" style="padding: 0; overflow: hidden;">
        <img src="banner-planos.webp" alt="Comparativo de planos Cobrei?" style="width: 100%; height: auto; display: block; border-radius: 12px 12px 0 0;" onerror="this.style.display='none'">
      </div>
      <div class="card">
        <h2>Assinatura</h2>
        <p>Plano atual: <strong>${currentUserPlan.toUpperCase()}</strong></p>
        ${currentUserPlan === 'free' ? `
          <div style="margin-top: 1rem;">
            <input type="text" id="codigoAtivacao" placeholder="Digite seu código de ativação" style="width: 70%; padding: 8px; margin-right: 8px;">
            <button id="btnAtivarCodigo" class="btn">Ativar</button>
          </div>
        ` : `<p>✅ Plano ativo via código: ${codigoAtivacao || ''}</p>`}
        <hr>
        <h3>Tema</h3>
        <button id="toggleThemeBtn" class="btn-outline">Alternar modo escuro</button>
      </div>
    `;
  } catch (err) {
    console.error('Erro ao renderizar configurações:', err);
    return `<div class="card">Erro ao carregar configurações. Tente recarregar a página.</div>`;
  }
}

// -------- RENDER PRINCIPAL E EVENTOS ----------
async function renderView(view) {
  if (intervaloCarrossel) {
    clearInterval(intervaloCarrossel);
    intervaloCarrossel = null;
  }
  if (window.carrosselTimeout) {
    clearTimeout(window.carrosselTimeout);
    window.carrosselTimeout = null;
  }
  activeView = view;
  const main = document.getElementById('mainContent');
  let content = '';
  switch (view) {
    case 'dashboard': content = await renderDashboard(); break;
    case 'clientes': content = await renderClientes(); break;
    case 'cobrancas': content = await renderCobrancas(); break;
    case 'mensagens': content = await renderMensagens(); break;
    case 'relatorios': content = await renderRelatorios(); break;
    case 'configuracoes': content = await renderConfiguracoes(); break;
    default: content = '<div class="card">Página não encontrada</div>';
  }
  main.innerHTML = content;
  attachViewEvents(view);
}

function attachViewEvents(view) {
  if (view === 'dashboard') {
  (async () => {
    const cobrancas = await listarCobrancas();
    const now = new Date();
    const vencidas = cobrancas.filter(c => new Date(c.vencimento) < now && c.status !== 'paga');
    iniciarCarrossel(vencidas);

    // ====== Botão de ocultar/mostrar valor ======
    const toggleBtn = document.getElementById('toggleRecebidoBtn');
    if (toggleBtn) {
      // Remove listeners antigos para evitar duplicação
      const newBtn = toggleBtn.cloneNode(true);
      toggleBtn.parentNode.replaceChild(newBtn, toggleBtn);
      newBtn.addEventListener('click', async () => {
        // Lê o estado atual do banco
        let hide = await getConfig('hideRecebido');
        hide = (hide === true || hide === 'true');
        // Inverte
        hide = !hide;
        await setConfig('hideRecebido', hide);
        // Atualiza a exibição
        const todasCobrancas = await listarCobrancas();
        const totalRecebido = todasCobrancas.filter(c => c.status === 'paga').reduce((s, c) => s + Number(c.valor), 0);
        const spanValor = document.getElementById('recebidoValor');
        if (spanValor) {
          spanValor.innerText = hide ? '••••' : `R$ ${totalRecebido.toFixed(2)}`;
        }
        // Muda o ícone do botão (opcional)
        newBtn.textContent = hide ? '👁️‍🗨️' : '👁️';
      });
    }
  })();
  }
  if (view === 'clientes') {
    document.getElementById('novoClienteBtn')?.addEventListener('click', async () => {
      const clientesAtuais = await listarClientes();
      if (currentUserPlan === 'free' && clientesAtuais.length >= planLimits.free.maxClients) {
        showToast(`Limite de ${planLimits.free.maxClients} clientes atingido.`, 'warning');
        return;
      }
      abrirModalCliente();
    });
    document.getElementById('importarContatosBtn')?.addEventListener('click', importarContatos);
    document.querySelectorAll('.editCliente').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = Number(btn.dataset.id);
        const clientes = await listarClientes();
        const cliente = clientes.find(c => c.id === id);
        if (cliente) abrirModalCliente(cliente);
      });
    });
    document.querySelectorAll('.delCliente').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (confirm('Excluir cliente?')) {
          await excluirCliente(Number(btn.dataset.id));
          renderView('clientes');
        }
      });
    });
  }
  if (view === 'cobrancas') {
    document.getElementById('novaCobrancaBtn')?.addEventListener('click', () => abrirModalCobranca());
    document.querySelectorAll('.pagarCobranca').forEach(btn => {
      btn.addEventListener('click', async () => { await processarPagamentoCobranca(Number(btn.dataset.id)); });
    });
    document.querySelectorAll('.delCobranca').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Excluir cobrança?')) { await excluirCobranca(Number(btn.dataset.id)); renderView('cobrancas'); }
      });
    });
  }
  if (view === 'mensagens') {
    if (currentUserPlan !== 'free') {
      document.getElementById('addMsgBtn')?.addEventListener('click', () => {
        const nome = prompt('Nome do template');
        const texto = prompt('Texto (use {cliente}, {valor}, {vencimento})');
        if (nome && texto) { saveItem('mensagens', { nome, texto }); renderView('mensagens'); }
      });
    }
    document.querySelectorAll('.copyMsgBtn').forEach(btn => {
      btn.addEventListener('click', () => { navigator.clipboard.writeText(btn.dataset.text); showToast('Copiado!'); });
    });
    document.querySelectorAll('.whatsMsgBtn').forEach(btn => {
      btn.addEventListener('click', async (e) => { abrirModalEscolherClienteMensagem(btn.dataset.whats); });
    });
    document.querySelectorAll('.delMsgBtn').forEach(btn => {
      btn.addEventListener('click', async () => { await deleteItem('mensagens', Number(btn.dataset.id)); renderView('mensagens'); });
    });
  }
  if (view === 'relatorios') {
  document.getElementById('exportarCSV')?.addEventListener('click', exportarCSV);
  document.getElementById('exportarPDF')?.addEventListener('click', exportarPDF);

  // Função para criar/recriar o gráfico com um pequeno delay (garante que o canvas esteja no DOM)
  const criarGrafico = async () => {
    const canvas = document.getElementById('graficoRecebimentos');
    if (!canvas) {
      console.warn('Canvas #graficoRecebimentos não encontrado');
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cobrancas = await listarCobrancas();
    const pagasPorMes = {};
    cobrancas.filter(c => c.status === 'paga').forEach(c => {
      const mes = c.vencimento?.substring(0, 7);
      if (mes) pagasPorMes[mes] = (pagasPorMes[mes] || 0) + Number(c.valor);
    });

    const meses = Object.keys(pagasPorMes).sort();
    const valores = meses.map(m => pagasPorMes[m]);

    // Se o Chart não estiver disponível, tenta carregar novamente (fallback)
    if (typeof Chart === 'undefined') {
      console.error('Chart.js não carregado – tentando recarregar');
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
      script.onload = () => criarGrafico();
      document.head.appendChild(script);
      return;
    }

    // Destruir gráfico anterior se existir para evitar duplicação
    if (window.meuGrafico) {
      window.meuGrafico.destroy();
    }

    // Se não houver dados, exibir mensagem no canvas
    if (meses.length === 0) {
      canvas.style.display = 'none';
      const msgDiv = document.createElement('div');
      msgDiv.id = 'semDadosMsg';
      msgDiv.style.cssText = 'text-align:center; padding:2rem; color:#666; background:#f5f5f5; border-radius:12px;';
      msgDiv.innerText = '📊 Nenhum recebimento registrado ainda. Marque cobranças como pagas para ver o gráfico.';
      canvas.parentNode?.insertBefore(msgDiv, canvas.nextSibling);
      return;
    } else {
      canvas.style.display = 'block';
      const msgAntiga = document.getElementById('semDadosMsg');
      if (msgAntiga) msgAntiga.remove();
    }

    // Criar gráfico
    window.meuGrafico = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: meses,
        datasets: [{
          label: 'Recebido (R$)',
          data: valores,
          backgroundColor: '#2F855A',
          borderRadius: 8,
          barPercentage: 0.7
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: (ctx) => `R$ ${ctx.raw.toFixed(2)}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { callback: (value) => `R$ ${value}` }
          }
        }
      }
    });
  };

  // Executa o gráfico com pequeno delay para garantir que o DOM foi atualizado
  setTimeout(criarGrafico, 150);

  // Filtros da tabela
  const filtroTodas = document.getElementById('filtroTodas');
  const filtroPendentes = document.getElementById('filtroPendentes');
  const filtroPagas = document.getElementById('filtroPagas');
  const tabelaDiv = document.getElementById('tabelaDinamica');

  const atualizarTabela = async (filtro) => {
    const cobrancas = await listarCobrancas();
    tabelaDiv.innerHTML = gerarTabelaCobrancas(cobrancas, filtro);
  };

  filtroTodas?.addEventListener('click', () => atualizarTabela('todas'));
  filtroPendentes?.addEventListener('click', () => atualizarTabela('pendentes'));
  filtroPagas?.addEventListener('click', () => atualizarTabela('pagas'));
  }
  if (view === 'configuracoes') {
  // Botão de ativação via código
  const btnAtivar = document.getElementById('btnAtivarCodigo');
  if (btnAtivar) {
    btnAtivar.addEventListener('click', async () => {
      const codigoInput = document.getElementById('codigoAtivacao');
      const codigo = codigoInput.value.trim();
      if (!codigo) {
        showToast('Digite um código de ativação.', 'warning');
        return;
      }
      // Escolha o método: local ou remoto
      await validarCodigoRemoto(codigo);  // ou validarCodigoRemoto(codigo)
    });
  }

  // Botão de tema escuro
  document.getElementById('toggleThemeBtn')?.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    setConfig('tema', document.body.classList.contains('dark') ? 'dark' : 'light');
  });
  }
}

// -------- LEMBRETES COM RESTRIÇÃO DE PLANO ----------
function startReminderChecker() {
  setInterval(async () => {
    if (Notification.permission !== 'granted') return;
    const cobrancas = await listarCobrancas();
    const hoje = new Date().toISOString().slice(0,10);
    for (let c of cobrancas) {
      if (c.status === 'paga') continue;
      if (c.vencimento === hoje && !c.notifiedToday) {
        new Notification(`Cobrança vence hoje: ${c.clienteNome} - R$ ${c.valor}`);
        c.notifiedToday = true;
        await salvarCobranca(c);
      } else if (c.vencimento < hoje && !c.notifiedOverdue && currentUserPlan !== 'free') {
        // Apenas Pro/Team notificam atraso
        new Notification(`Cobrança em atraso: ${c.clienteNome} - R$ ${c.valor}`);
        c.notifiedOverdue = true;
        await salvarCobranca(c);
      }
    }
  }, 30000);
}

function requestNotificationPermission() {
  if ('Notification' in navigator) Notification.requestPermission();
}

// -------- IMPORTAR CONTATOS COM LIMITE POR LOTE (FREE) ----------
async function importarContatos() {
  if ('contacts' in navigator && 'select' in navigator.contacts) {
    try {
      const props = ['name', 'tel'];
      const opts = { multiple: true };
      const contacts = await navigator.contacts.select(props, opts);
      if (!contacts || contacts.length === 0) { showToast('Nenhum contato selecionado.'); return; }
      await processarContatosImportados(contacts, 'API nativa');
      return;
    } catch (err) { showToast('Erro na API. Tentando CSV...', 'info'); }
  }
  importarContatosViaCSV();
}

async function processarContatosImportados(contacts, origem) {
  let maxBatch = planLimits[currentUserPlan].maxImportPerBatch;
  if (currentUserPlan === 'free' && contacts.length > maxBatch) {
    if (!confirm(`Plano Free importa no máximo ${maxBatch} contatos por vez. Deseja continuar apenas com os primeiros ${maxBatch}?`)) return;
    contacts = contacts.slice(0, maxBatch);
  }
  let importados = 0, ignorados = 0;
  const clientesExistentes = await listarClientes();
  const nomesExistentes = new Set(clientesExistentes.map(c => c.nome.toLowerCase().trim()));
  for (const contact of contacts) {
    const nome = contact.name && contact.name[0] ? contact.name[0].trim() : '';
    if (!nome) continue;
    if (nomesExistentes.has(nome.toLowerCase())) { ignorados++; continue; }
    let telefone = '';
    if (contact.tel && contact.tel.length > 0) {
      let rawTel = contact.tel[0].replace(/\D/g, '');
      telefone = formatPhoneToBrazil(rawTel);
    }
    const clientesAtuais = await listarClientes();
    if (currentUserPlan === 'free' && clientesAtuais.length >= planLimits.free.maxClients) {
      showToast(`Limite de clientes do Free atingido (${planLimits.free.maxClients}).`, 'warning');
      break;
    }
    const novoCliente = { nome, telefone, email: '', categoria: 'Importado', observacoes: `Importado (${origem})`, status: 'ativo' };
    await salvarCliente(novoCliente);
    importados++;
    nomesExistentes.add(nome.toLowerCase());
  }
  showToast(`Importação: ${importados} adicionados, ${ignorados} ignorados.`, 'success');
  await renderView('clientes');
}

function importarContatosViaCSV() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv, .vcf, text/csv';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) { document.body.removeChild(input); return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
      const conteudo = e.target.result;
      let linhas = [];
      if (file.name.endsWith('.csv')) {
        const primeiroLinha = conteudo.split(/\r?\n/)[0];
        const separador = primeiroLinha.includes(';') ? ';' : ',';
        linhas = conteudo.split(/\r?\n/).map(linha => linha.split(separador).map(campo => campo.replace(/^"|"$/g, '').trim()));
      } else if (file.name.endsWith('.vcf')) {
        linhas = parseVCard(conteudo);
      } else { showToast('Formato não suportado. Use CSV ou VCF.', 'error'); document.body.removeChild(input); return; }
      if (linhas.length === 0) { showToast('Arquivo vazio.', 'warning'); document.body.removeChild(input); return; }
      let cabecalho = linhas[0];
      let idxNome = -1, idxTel = -1;
      for (let i = 0; i < cabecalho.length; i++) {
        const col = cabecalho[i].toLowerCase();
        if (col.includes('nome') || col === 'name') idxNome = i;
        if (col.includes('telefone') || col === 'tel' || col.includes('phone')) idxTel = i;
      }
      if (idxNome === -1) idxNome = 0;
      if (idxTel === -1) idxTel = 1;
      let inicio = (cabecalho.some(campo => ['nome','name','telefone','tel','phone'].includes(campo.toLowerCase()))) ? 1 : 0;
      let contatos = [];
      for (let i = inicio; i < linhas.length; i++) {
        const linha = linhas[i];
        if (linha.length <= Math.max(idxNome, idxTel)) continue;
        let nome = linha[idxNome] ? linha[idxNome].trim() : '';
        if (!nome) continue;
        let telefoneRaw = linha[idxTel] ? linha[idxTel].replace(/\D/g, '') : '';
        let telefone = telefoneRaw ? formatPhoneToBrazil(telefoneRaw) : '';
        contatos.push({ name: [nome], tel: [telefone] });
      }
      await processarContatosImportados(contatos, 'CSV/VCF');
      document.body.removeChild(input);
    };
    reader.readAsText(file, 'UTF-8');
  };
  input.click();
}

function parseVCard(conteudo) {
  const linhas = conteudo.split(/\r?\n/);
  const contatos = [];
  let contatoAtual = { nome: '', telefone: '' };
  for (let linha of linhas) {
    linha = linha.trim();
    if (linha.startsWith('FN:')) contatoAtual.nome = linha.substring(3).trim();
    else if (linha.startsWith('TEL;')) {
      const telPart = linha.split(':')[1];
      if (telPart) contatoAtual.telefone = telPart.replace(/\D/g, '');
    } else if (linha === 'END:VCARD') {
      if (contatoAtual.nome) contatos.push([contatoAtual.nome, contatoAtual.telefone]);
      contatoAtual = { nome: '', telefone: '' };
    }
  }
  return contatos;
}

// -------- FUNÇÃO AUXILIAR DE FORMATAÇÃO DE TELEFONE (já existente) ----------
function formatPhoneToBrazil(phoneNumber) {
  if (!phoneNumber) return '';
  let digits = phoneNumber.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (!digits.startsWith('55')) digits = '55' + digits;
  const ddd = digits.substring(2, 4);
  const rest = digits.substring(4);
  let formatted = '';
  if (rest.length >= 9) formatted = `+55 (${ddd}) ${rest.substring(0,1)} ${rest.substring(1,5)}-${rest.substring(5,9)}`;
  else if (rest.length === 8) formatted = `+55 (${ddd}) ${rest.substring(0,4)}-${rest.substring(4,8)}`;
  else formatted = `+55 (${ddd}) ${rest}`;
  return formatted.trim();
}

  // -------- INSTALAÇÃO DO PWA ----------
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btnInstall = document.getElementById('btnInstall');
  if (btnInstall) btnInstall.style.display = 'inline-block';
});

document.getElementById('btnInstall')?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`Instalação: ${outcome}`);
  deferredPrompt = null;
  document.getElementById('btnInstall').style.display = 'none';
});

// -------- SERVICE WORKER ----------
function registerServiceWorker() {
  navigator.serviceWorker.register('./worker-server.js', { updateViaCache: 'none' })
  .then(() => console.log('SW registrado'))
  .catch(err => console.warn(err));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./worker-server.js').then(() => console.log('SW registrado')).catch(err => console.warn(err));
  }
}

// -------- INICIALIZAÇÃO ----------
document.addEventListener('DOMContentLoaded', async () => {
  await initDatabase();
  await loadConfig();
  registerServiceWorker();
  requestNotificationPermission();
  setupEventListeners();
  await renderView('dashboard');
  startReminderChecker();
  showToast('Cobrei? pronto para usar!');
  // Fechar barra promocional manualmente
  const closePromoBtn = document.getElementById('closePromoBarBtn');
  if (closePromoBtn) {
  closePromoBtn.addEventListener('click', () => {
    const bar = document.getElementById('promoBar');
    if (bar) bar.classList.remove('show');
    // Fallback: se o botão não apareceu após 5 segundos, mostra instrução manual
setTimeout(() => {
  const btn = document.getElementById('btnInstall');
  if (btn && btn.style.display !== 'inline-block') {
    btn.style.display = 'inline-block';
    btn.textContent = '📲 Instalar (manual)';
    btn.onclick = () => {
      alert('Para instalar o app, abra o menu do navegador (três pontos) e escolha "Instalar aplicativo" ou "Adicionar à tela inicial".');
    };
  }
  }, 5000);
  });
}
});

function setupEventListeners() {
  document.getElementById('menuToggle')?.addEventListener('click', () => { document.getElementById('sidebar').classList.toggle('open'); });
  document.querySelectorAll('.nav-links li').forEach(li => {
    li.addEventListener('click', (e) => {
      const view = li.dataset.view;
      if (!view) return;
      document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
      li.classList.add('active');
      renderView(view);
      if (window.innerWidth < 768) document.getElementById('sidebar').classList.remove('open');
    });
  });
}

// -------- FUNÇÕES ADICIONAIS PARA MODAL DE MENSAGEM (já existentes) ----------
async function abrirModalEscolherClienteMensagem(templateTexto) {
  const clientes = await listarClientes();
  if (clientes.length === 0) { showToast('Cadastre um cliente primeiro.', 'warning'); return; }
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Enviar mensagem via WhatsApp</h3>
      <p>Escolha o cliente e, se desejar, uma cobrança específica:</p>
      <select id="msgClienteId" style="width:100%; margin:8px 0; padding:8px"><option value="">-- Selecione --</option>${clientes.map(c => `<option value="${c.id}">${c.nome} ${c.telefone ? `(${c.telefone})` : ''}</option>`).join('')}</select>
      <select id="msgCobrancaId" style="width:100%; margin:8px 0; padding:8px"><option value="">-- Nenhuma cobrança específica --</option></select>
      <div style="display:flex; gap:8px; justify-content:flex-end"><button class="btn-outline" id="modalCancelarMsg">Cancelar</button><button class="btn" id="modalEnviarMsg">Enviar WhatsApp</button></div>
    </div>`;
  document.body.appendChild(modal);
  const clienteSelect = modal.querySelector('#msgClienteId');
  const cobrancaSelect = modal.querySelector('#msgCobrancaId');
  clienteSelect.addEventListener('change', async (e) => {
    const clienteId = parseInt(e.target.value);
    if (!clienteId) { cobrancaSelect.innerHTML = '<option value="">-- Nenhuma --</option>'; return; }
    const todasCobrancas = await listarCobrancas();
    const cobrancasCliente = todasCobrancas.filter(c => c.clienteId === clienteId && c.status !== 'paga');
    let options = '<option value="">-- Nenhuma cobrança específica --</option>';
    cobrancasCliente.forEach(c => { options += `<option value="${c.id}">R$ ${c.valor} - Venc: ${c.vencimento}</option>`; });
    cobrancaSelect.innerHTML = options;
  });
  document.getElementById('modalCancelarMsg').onclick = () => modal.remove();
  document.getElementById('modalEnviarMsg').onclick = async () => {
    const clienteId = clienteSelect.value;
    if (!clienteId) { showToast('Selecione um cliente', 'warning'); return; }
    const cliente = clientes.find(c => c.id == clienteId);
    const cobrancaId = cobrancaSelect.value;
    let cobranca = null;
    if (cobrancaId) { const todas = await listarCobrancas(); cobranca = todas.find(c => c.id == cobrancaId); }
    let textoFinal = templateTexto;
    textoFinal = textoFinal.replace(/{cliente}/g, cliente.nome);
    if (cobranca) {
      textoFinal = textoFinal.replace(/{valor}/g, `R$ ${cobranca.valor}`);
      textoFinal = textoFinal.replace(/{vencimento}/g, cobranca.vencimento);
    } else {
      textoFinal = textoFinal.replace(/{valor}/g, '[valor]');
      textoFinal = textoFinal.replace(/{vencimento}/g, '[data]');
    }
    const numero = cliente.telefone ? cliente.telefone.replace(/\D/g, '') : '';
    let link = `https://wa.me/${numero}?text=${encodeURIComponent(textoFinal)}`;
    if (!numero) link = `https://wa.me/?text=${encodeURIComponent(textoFinal)}`;
    window.open(link, '_blank');
    modal.remove();
  };
}