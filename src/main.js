import { createClient } from '@supabase/supabase-js';
import './style.css';

const config = {
  url: import.meta.env.VITE_SUPABASE_URL,
  key: import.meta.env.VITE_SUPABASE_ANON_KEY,
};
const app = document.querySelector('#app');
const money = (amount) => `Rs. ${Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (value) => value ? new Date(value).toLocaleDateString() : '—';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const statusPill = (status) => `<span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
let supabase;
let user;
let profile;
let data = { members: [], applications: [], loans: [], transactions: [], notifications: [], audit: [], cashBalance: 0, depositTotal: 0 };
let notice = '';
let busy = false;

function showMessage(message, isError = false) {
  notice = message;
  render();
  const element = document.querySelector('.flash');
  if (element) element.classList.toggle('error', isError);
}

function setupScreen() {
  app.innerHTML = `<main class="auth-shell"><section class="auth-card">
    <div class="brand-mark">अ</div><h1>Connect your Kosh portal</h1>
    <p class="muted">Add your Supabase project URL and public key to a local <code>.env</code> file. Never put a service-role key in this app.</p>
    <p class="muted small">See <b>README.md</b> for the secure database setup, access policies, and first administrator instructions.</p>
  </section></main>`;
}

function loginScreen() {
  app.innerHTML = `<main class="auth-shell"><section class="auth-card">
    <div class="brand-mark">अ</div><p class="eyebrow">ASHTAMANGAL KOSH</p><h1>Member & board portal</h1>
    <p class="muted">Sign in with the email and password provided to you by the Kosh administrator.</p>
    ${notice ? `<p class="flash">${escapeHtml(notice)}</p>` : ''}
    <form id="login-form"><label>Email address<input name="email" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Signing in…' : 'Sign in'}</button></form>
    <p class="muted small">Accounts are issued by the Kosh administrator. There is no public sign-up.</p>
  </section></main>`;
  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await perform(async () => {
      const form = new FormData(event.currentTarget);
      const { error } = await supabase.auth.signInWithPassword({
        email: String(form.get('email')).trim(),
        password: String(form.get('password')),
      });
      if (error) throw error;
      await loadPortal();
    }, 'Signed in.');
  });
}

async function perform(action, successMessage) {
  busy = true;
  render();
  try {
    await action();
    notice = successMessage || '';
  } catch (error) {
    notice = error.message || 'The request could not be completed.';
    console.error(error);
  } finally {
    busy = false;
    render();
  }
}

async function loadPortal() {
  const { data: currentUserData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  user = currentUserData.user;
  if (!user) {
    profile = null;
    loginScreen();
    return;
  }
  const { data: memberProfile, error: profileError } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, active, loan_limit')
    .eq('id', user.id)
    .single();
  if (profileError) throw profileError;
  if (!memberProfile.active) {
    await supabase.auth.signOut();
    throw new Error('This account is inactive. Contact a Kosh administrator.');
  }
  profile = memberProfile;
  await refreshData();
  render();
}

async function refreshData() {
  const queries = [
    supabase.from('loan_applications').select('id, requested_amount, approved_amount, purpose, status, decision_note, created_at, decided_at, member_id').order('created_at', { ascending: false }),
    supabase.from('loans').select('id, member_id, principal, outstanding_principal, accrued_interest, interest_rate, status, disbursed_at, last_interest_at').order('disbursed_at', { ascending: false }),
    supabase.from('transactions').select('id, member_id, loan_id, transaction_type, amount, principal_component, interest_component, reference, description, created_at, created_by').order('created_at', { ascending: false }).limit(200),
    supabase.from('notifications').select('id, title, message, created_at, read_at').order('created_at', { ascending: false }).limit(30),
  ];
  if (profile.role === 'admin') {
    queries.push(supabase.from('profiles').select('id, email, full_name, role, active, loan_limit').order('full_name'));
    queries.push(supabase.rpc('get_cash_balance'));
    queries.push(supabase.from('audit_log').select('id, actor_id, action, entity_type, entity_id, details, created_at').order('created_at', { ascending: false }).limit(200));
  } else {
    queries.push(supabase.rpc('get_my_deposit_total'));
  }
  const results = await Promise.all(queries);
  for (const result of results) if (result.error) throw result.error;
  data.applications = results[0].data || [];
  data.loans = results[1].data || [];
  data.transactions = results[2].data || [];
  data.notifications = results[3].data || [];
  data.members = profile.role === 'admin' ? (results[4]?.data || []) : [profile];
  if (profile.role === 'admin') {
    data.cashBalance = Number(results[5].data || 0);
    data.audit = results[6].data || [];
  }
  else data.depositTotal = Number(results[4].data || 0);
}

function memberName(memberId) {
  return data.members.find((member) => member.id === memberId)?.full_name || 'My account';
}

function accountLoanTotals(loan) {
  const outstanding = Number(loan.outstanding_principal);
  const elapsed = Math.max(0, Date.now() - new Date(loan.last_interest_at).getTime()) / 86400000;
  const accrued = Number(loan.accrued_interest) + outstanding * Number(loan.interest_rate) / 100 * elapsed / 365;
  return { outstanding, interest: accrued };
}

function transactionsTable(rows) {
  if (!rows.length) return '<p class="empty">No transactions have been posted yet.</p>';
  return `<div class="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Member</th><th>Amount</th><th>Reference / details</th></tr></thead><tbody>${rows.map((item) => `<tr>
    <td>${date(item.created_at)}</td><td>${escapeHtml(item.transaction_type.replaceAll('_', ' '))}</td>
    <td>${escapeHtml(memberName(item.member_id))}</td><td>${money(item.amount)}</td>
    <td>${escapeHtml(item.reference || item.description || '—')}</td></tr>`).join('')}</tbody></table></div>`;
}

function memberCards() {
  const loans = data.loans.filter((loan) => loan.status === 'active');
  const principal = loans.reduce((sum, loan) => sum + accountLoanTotals(loan).outstanding, 0);
  const interest = loans.reduce((sum, loan) => sum + accountLoanTotals(loan).interest, 0);
  const availableLimit = Math.max(0, Number(profile.loan_limit) - principal);
  return `<section class="cards">
    <article class="metric"><span>Deposits recorded</span><b>${money(data.depositTotal)}</b></article>
    <article class="metric"><span>Principal outstanding</span><b>${money(principal)}</b></article>
    <article class="metric"><span>Estimated interest due</span><b>${money(interest)}</b><small>Simple daily interest; final amount confirmed at posting</small></article>
    <article class="metric"><span>Available loan limit</span><b>${money(availableLimit)}</b><small>Limit set by the Kosh board; deposits do not change it automatically</small></article>
  </section>`;
}

function memberView() {
  const myApplications = data.applications.filter((application) => application.member_id === profile.id);
  const myLoans = data.loans.filter((loan) => loan.status === 'active');
  const myTransactions = data.transactions.filter((row) => row.member_id === profile.id);
  return `${memberCards()}
    <section class="panel"><div class="panel-heading"><div><h2>My loan applications</h2><p class="muted">Applications are requests; a loan is created only after board approval and disbursement.</p></div></div>
    ${myApplications.length ? `<div class="table-scroll"><table><thead><tr><th>Submitted</th><th>Requested</th><th>Status</th><th>Decision note</th></tr></thead><tbody>${myApplications.map((row) => `<tr><td>${date(row.created_at)}</td><td>${money(row.requested_amount)}</td><td>${statusPill(row.status)}</td><td>${escapeHtml(row.decision_note || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No loan applications.</p>'}</section>
    <section class="panel"><div class="panel-heading"><div><h2>My active loans</h2><p class="muted">Interest estimates use the recorded rate and outstanding principal.</p></div><button class="primary" data-action="apply-loan">Apply for a loan</button></div>
    ${myLoans.length ? `<div class="table-scroll"><table><thead><tr><th>Loan</th><th>Disbursed</th><th>Rate</th><th>Principal due</th><th>Estimated interest</th></tr></thead><tbody>${myLoans.map((loan) => { const total = accountLoanTotals(loan); return `<tr><td>${escapeHtml(loan.id.slice(0, 8))}</td><td>${date(loan.disbursed_at)}</td><td>${Number(loan.interest_rate)}% p.a.</td><td>${money(total.outstanding)}</td><td>${money(total.interest)}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="empty">No active loans.</p>'}</section>
    <section class="panel"><div class="panel-heading"><div><h2>My recent transaction history</h2><p class="muted">Only your latest 200 transactions are shown.</p></div></div>${transactionsTable(myTransactions)}</section>
    ${notificationPanel()}`;
}

function notificationPanel() {
  return `<section class="panel"><div class="panel-heading"><div><h2>Notifications</h2><p class="muted">Updates from the Kosh board.</p></div></div>
    ${data.notifications.length ? data.notifications.map((item) => `<article class="notification"><b>${escapeHtml(item.title)}</b><time>${date(item.created_at)}</time><p>${escapeHtml(item.message)}</p></article>`).join('') : '<p class="empty">No notifications yet.</p>'}</section>`;
}

function adminView() {
  const pending = data.applications.filter((row) => row.status === 'pending');
  const principal = data.loans.filter((loan) => loan.status === 'active').reduce((sum, loan) => sum + Number(loan.outstanding_principal), 0);
  return `<section class="cards">
    <article class="metric"><span>Available recorded cash</span><b>${money(data.cashBalance)}</b><small>Deposits and repayments minus disbursements</small></article>
    <article class="metric"><span>Active members</span><b>${data.members.filter((member) => member.role === 'member' && member.active).length}</b></article>
    <article class="metric"><span>Outstanding principal</span><b>${money(principal)}</b></article>
    <article class="metric"><span>Applications awaiting review</span><b>${pending.length}</b></article>
  </section>
  <section class="panel"><div class="panel-heading"><div><h2>Loan applications</h2><p class="muted">Approval checks the member's configured limit and available Kosh cash. Approval disburses atomically.</p></div></div>
  ${pending.length ? `<div class="table-scroll"><table><thead><tr><th>Member</th><th>Requested</th><th>Purpose</th><th>Submitted</th><th>Decision</th></tr></thead><tbody>${pending.map((row) => `<tr><td>${escapeHtml(memberName(row.member_id))}</td><td>${money(row.requested_amount)}</td><td>${escapeHtml(row.purpose)}</td><td>${date(row.created_at)}</td><td class="actions"><button class="primary small" data-action="approve" data-id="${row.id}">Approve & disburse</button><button class="secondary small" data-action="reject" data-id="${row.id}">Reject</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No pending applications.</p>'}</section>
  <section class="panel"><div class="panel-heading"><div><h2>Post a deposit</h2><p class="muted">Posting writes the immutable ledger entry and notifies the member.</p></div></div>
    <form id="deposit-form" class="inline-form"><label>Member<select name="member_id" required>${data.members.filter((member) => member.role === 'member' && member.active).map((member) => `<option value="${member.id}">${escapeHtml(member.full_name)} · ${escapeHtml(member.email)}</option>`).join('')}</select></label>
    <label>Amount (Rs.)<input name="amount" type="number" min="0.01" step="0.01" required></label><label>Receipt / reference<input name="reference" maxlength="120"></label><label>Description<input name="description" maxlength="300"></label>
    <button class="primary" ${busy ? 'disabled' : ''}>Post deposit</button></form></section>
  <section class="panel"><div class="panel-heading"><div><h2>Member accounts</h2><p class="muted">Invite accounts in Supabase Authentication first. Set each board-approved loan limit and active status here, then select Save.</p></div></div>
    <div class="table-scroll"><table><thead><tr><th>Member</th><th>Email</th><th>Loan limit (Rs.)</th><th>Active</th><th></th></tr></thead><tbody>${data.members.filter((member) => member.role === 'member').map((member) => `<tr><td><input aria-label="Name for ${escapeHtml(member.email)}" type="text" maxlength="120" value="${escapeHtml(member.full_name)}" data-name="${member.id}"></td><td>${escapeHtml(member.email)}</td><td><input aria-label="Loan limit for ${escapeHtml(member.full_name)}" type="number" min="0" step="0.01" value="${Number(member.loan_limit)}" data-limit="${member.id}"></td><td><input type="checkbox" aria-label="Active ${escapeHtml(member.full_name)}" data-active="${member.id}" ${member.active ? 'checked' : ''}></td><td><button class="secondary small" data-action="save-member" data-id="${member.id}">Save</button></td></tr>`).join('')}</tbody></table></div></section>
  <section class="panel"><div class="panel-heading"><div><h2>Active loans</h2><p class="muted">Post a repayment; the database calculates accrued interest and allocates principal atomically.</p></div></div>
    ${data.loans.filter((loan) => loan.status === 'active').length ? `<div class="table-scroll"><table><thead><tr><th>Member</th><th>Outstanding principal</th><th>Accrued interest</th><th>Rate</th><th></th></tr></thead><tbody>${data.loans.filter((loan) => loan.status === 'active').map((loan) => { const totals = accountLoanTotals(loan); return `<tr><td>${escapeHtml(memberName(loan.member_id))}</td><td>${money(totals.outstanding)}</td><td>${money(totals.interest)}</td><td>${Number(loan.interest_rate)}% p.a.</td><td><button class="secondary small" data-action="repayment" data-id="${loan.id}">Post repayment</button></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="empty">No active loans.</p>'}</section>
  <section class="panel"><div class="panel-heading"><div><h2>Recent transaction ledger</h2><p class="muted">Latest 200 entries; ledger records are append-only.</p></div></div>${transactionsTable(data.transactions)}</section>
  <section class="panel"><div class="panel-heading"><div><h2>Audit trail</h2><p class="muted">Latest 200 recorded actions, including application decisions and transaction postings.</p></div></div>
    ${data.audit.length ? `<div class="table-scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>${data.audit.map((item) => `<tr><td>${new Date(item.created_at).toLocaleString()}</td><td>${escapeHtml(memberName(item.actor_id))}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.entity_type)} · ${escapeHtml(item.entity_id.slice(0, 8))}</td><td>${escapeHtml(JSON.stringify(item.details))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No audit events recorded yet.</p>'}</section>
  ${notificationPanel()}`;
}

function render() {
  if (!supabase) return setupScreen();
  if (!user || !profile) return loginScreen();
  const admin = profile.role === 'admin';
  app.innerHTML = `<header class="topbar"><div class="brand"><span class="brand-icon">अ</span><div><b>Ashtamangal Kosh</b><small>${admin ? 'Board workspace' : 'Member portal'}</small></div></div>
    <div class="top-actions"><span>${escapeHtml(profile.full_name || profile.email)}</span><button class="secondary" data-action="refresh" ${busy ? 'disabled' : ''}>Refresh</button><button class="secondary" data-action="sign-out">Sign out</button></div></header>
    <main class="content"><div class="page-heading"><div><p class="eyebrow">${admin ? 'ADMINISTRATION' : 'YOUR ACCOUNT'}</p><h1>${admin ? 'Kosh overview' : `Namaste, ${escapeHtml(profile.full_name || 'member')}`}</h1><p class="muted">${admin ? 'Review applications and post verified Kosh transactions.' : 'Your account balances and transaction history.'}</p></div></div>
    ${notice ? `<p class="flash">${escapeHtml(notice)}</p>` : ''}${admin ? adminView() : memberView()}</main>`;
  bindActions();
}

function bindActions() {
  document.querySelector('[data-action="sign-out"]')?.addEventListener('click', () => perform(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    user = null; profile = null; notice = '';
    render();
  }));
  document.querySelector('[data-action="refresh"]')?.addEventListener('click', () => perform(refreshData, 'Portal data refreshed.'));
  document.querySelector('[data-action="apply-loan"]')?.addEventListener('click', applyForLoan);
  document.querySelector('#deposit-form')?.addEventListener('submit', postDeposit);
  document.querySelectorAll('[data-action="approve"]').forEach((button) => button.addEventListener('click', () => decideApplication(button.dataset.id, true)));
  document.querySelectorAll('[data-action="reject"]').forEach((button) => button.addEventListener('click', () => decideApplication(button.dataset.id, false)));
  document.querySelectorAll('[data-action="save-member"]').forEach((button) => button.addEventListener('click', () => saveMember(button.dataset.id)));
  document.querySelectorAll('[data-action="repayment"]').forEach((button) => button.addEventListener('click', () => postRepayment(button.dataset.id)));
}

async function applyForLoan() {
  const activePrincipal = data.loans
    .filter((loan) => loan.status === 'active')
    .reduce((sum, loan) => sum + accountLoanTotals(loan).outstanding, 0);
  const availableLimit = Math.max(0, Number(profile.loan_limit) - activePrincipal);
  if (availableLimit <= 0) {
    const message = `Your loan limit is set manually by the Kosh board and does not increase automatically with deposits. Your available limit is ${money(availableLimit)}. Ask an administrator to update it in the Admin portal under Member accounts, then refresh this page.`;
    notice = message;
    render();
    return;
  }
  const amount = prompt(`Your available loan limit is ${money(availableLimit)}. Enter the amount to request (Rs.):`);
  if (amount === null) return;
  const purpose = prompt('What is the purpose of this loan?');
  if (purpose === null) return;
  await perform(async () => {
    const { error } = await supabase.rpc('submit_loan_application', { p_amount: Number(amount), p_purpose: purpose.trim() });
    if (error) throw error;
    await refreshData();
  }, 'Loan application submitted to the board.');
}

async function postDeposit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await perform(async () => {
    const { error } = await supabase.rpc('record_deposit', {
      p_member_id: form.get('member_id'),
      p_amount: Number(form.get('amount')),
      p_reference: String(form.get('reference') || ''),
      p_description: String(form.get('description') || ''),
    });
    if (error) throw error;
    await refreshData();
  }, 'Deposit posted and member notified.');
}

async function decideApplication(id, approve) {
  let note = prompt(approve ? 'Optional approval note:' : 'Reason for rejection (required):');
  if (note === null) return;
  await perform(async () => {
    const { error } = await supabase.rpc('decide_loan_application', {
      p_application_id: id,
      p_approve: approve,
      p_decision_note: note.trim(),
    });
    if (error) throw error;
    await refreshData();
  }, approve ? 'Loan approved and disbursed; member notified.' : 'Application rejected; member notified.');
}

async function saveMember(id) {
  const name = document.querySelector(`[data-name="${id}"]`);
  const limit = document.querySelector(`[data-limit="${id}"]`);
  const active = document.querySelector(`[data-active="${id}"]`);
  await perform(async () => {
    const { error } = await supabase.rpc('update_member_settings', {
      p_member_id: id,
      p_full_name: name.value.trim(),
      p_loan_limit: Number(limit.value),
      p_active: active.checked,
    });
    if (error) throw error;
    await refreshData();
  }, 'Member settings saved.');
}

async function postRepayment(loanId) {
  const amount = prompt('Total repayment received (Rs.):');
  if (amount === null) return;
  const allocation = prompt('Allocation method: enter "interest-first" or "principal-first".', 'interest-first');
  if (allocation === null) return;
  const reference = prompt('Optional receipt / reference:') || '';
  await perform(async () => {
    const { error } = await supabase.rpc('record_repayment', {
      p_loan_id: loanId,
      p_amount: Number(amount),
      p_allocation: allocation.trim(),
      p_reference: reference.trim(),
    });
    if (error) throw error;
    await refreshData();
  }, 'Repayment posted and member notified.');
}

async function initialize() {
  if (!config.url || !config.key) {
    setupScreen();
    return;
  }
  supabase = createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data: sessionData, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (sessionData.session) {
    try {
      await loadPortal();
    } catch (loadError) {
      console.error(loadError);
      user = null; profile = null;
      showMessage(loadError.message || 'Could not load your account.');
    }
  } else loginScreen();
  supabase.auth.onAuthStateChange((_event, session) => {
    if (!session) {
      user = null; profile = null; render();
    }
  });
}

initialize().catch((error) => {
  console.error(error);
  app.innerHTML = `<main class="auth-shell"><section class="auth-card"><h1>Portal unavailable</h1><p class="flash error">${escapeHtml(error.message)}</p><button class="primary" onclick="location.reload()">Try again</button></section></main>`;
});
