/*
  ShieldX Demo (Manifest V3)
  Content script that injects:
  - A floating Shield button (always visible)
  - A slide-in panel showing a "risk score" based on keyword matching

  IMPORTANT:
  - This is a prototype demo.
  - No backend.
  - No real AI.
  - "Learning" is simulated by changing the displayed score/state.
*/

(() => {
  // Prevent double-injection if the content script runs more than once.
  if (document.getElementById('shieldx-root')) return;

  // -----------------------------
  // 1) Weighted scoring model (demo)
  // -----------------------------
  // This is still a rule-based prototype, but it feels more like a real model by:
  // - separating signals into categories
  // - applying weights
  // - producing an explainable contribution breakdown

  const KNOWN_TRUSTED_DOMAINS = [
    'mail.google.com',
    'gmail.com',
    'google.com',
    'outlook.com',
    'office.com',
    'microsoft.com'
  ];

  const DEFAULT_URGENCY_WEIGHT_MULTIPLIER = 1.0;
  const URGENCY_WEIGHT_STORAGE_KEY = 'shieldxUrgencyWeightMultiplier';

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function getRiskColorBucket(score) {
    if (score <= 30) return 'green';
    if (score <= 70) return 'yellow';
    return 'red';
  }

  function getSuggestedAction(score) {
    if (score > 65) return 'Do Not Click Links';
    if (score >= 40) return 'Verify Before Acting';
    return 'Likely Safe';
  }

  // Score -> risk bucket text.
  function getRiskLevel(score) {
    if (score < 40) return 'Low';
    if (score < 60) return 'Medium';
    if (score <= 70) return 'Medium-High';
    return 'High';
  }

  // Scan page text (document.body.innerText) and build a demo score.
  // NOTE: Some complex web apps (example: Gmail) render message text inside
  // contenteditable elements and/or iframes. document.body.innerText can miss
  // some of that text.
  function getSearchText() {
    const parts = [];

    try {
      if (document.body) {
        // Common cases
        if (document.body.innerText) parts.push(document.body.innerText);
        if (document.body.textContent) parts.push(document.body.textContent);

        // Gmail / rich editors often use contenteditable regions.
        const editableNodes = document.querySelectorAll('[contenteditable="true"], [role="textbox"]');
        editableNodes.forEach((el) => {
          const t = (el && (el.innerText || el.textContent)) ? (el.innerText || el.textContent) : '';
          if (t) parts.push(t);
        });
      }
    } catch (_) {
      // Ignore DOM access issues.
    }

    // Try to read same-origin iframes (cross-origin iframes will throw; that's expected).
    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((frame) => {
        try {
          const doc = frame.contentDocument;
          if (!doc || !doc.body) return;
          if (doc.body.innerText) parts.push(doc.body.innerText);
          if (doc.body.textContent) parts.push(doc.body.textContent);
        } catch (_) {
          // Cross-origin iframe; skip.
        }
      });
    } catch (_) {
      // Ignore
    }

    return parts.join('\n').toLowerCase();
  }

  function getCurrentHost() {
    try {
      return (window.location && window.location.host) ? window.location.host.toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function isKnownTrustedDomain(host) {
    const h = (host || '').toLowerCase();
    return KNOWN_TRUSTED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
  }

  function extractExternalLinkDomains() {
    const currentHost = getCurrentHost();
    const domains = new Set();

    try {
      const anchors = document.querySelectorAll('a[href]');
      anchors.forEach((a) => {
        try {
          const href = a.getAttribute('href') || '';
          const url = new URL(href, window.location.href);
          if (!url.host) return;
          const linkHost = url.host.toLowerCase();
          if (currentHost && linkHost !== currentHost) domains.add(linkHost);
        } catch (_) {
          // ignore invalid URLs
        }
      });
    } catch (_) {
      // ignore
    }

    return Array.from(domains);
  }

  function simulateDomainAgeLabel(domain) {
    // Deterministic (stable) simulation based on string char codes.
    let sum = 0;
    for (let i = 0; i < domain.length; i++) sum += domain.charCodeAt(i);
    const bucket = sum % 3;
    if (bucket === 0) return 'Low';
    if (bucket === 1) return 'Medium';
    return 'High';
  }

  function hasFormalTone(text) {
    // Simple heuristic: formal sign-offs / structure.
    const hasGreeting = text.includes('dear ') || text.includes('hello') || text.includes('hi ');
    const hasSignOff = text.includes('best regards') || text.includes('regards') || text.includes('sincerely');
    return hasGreeting && hasSignOff;
  }

  function computeSignals(text) {
    const hasUrgent = text.includes('urgent');
    const hasImmediate = text.includes('immediately') || text.includes('immediate');
    const hasScarcity = text.includes('limited time') || text.includes('limited offer') || text.includes('only today');
    const hasPayment = text.includes('fee') || text.includes('pay') || text.includes('payment') || text.includes('registration fee') || text.includes('₹') || text.includes('rs.');

    return {
      hasUrgent,
      hasImmediate,
      hasScarcity,
      hasPayment
    };
  }

  function computeWeightedRiskModel(text, urgencyWeightMultiplier) {
    const host = getCurrentHost();
    const trustedDomain = isKnownTrustedDomain(host);
    const externalDomains = extractExternalLinkDomains();
    const hasExternalLink = externalDomains.length > 0;

    const signals = computeSignals(text);

    // Category scores (0..100)
    const urgencyScoreBase = (signals.hasUrgent ? 60 : 0) + (signals.hasImmediate ? 40 : 0);
    const urgencyScore = clamp(Math.round(urgencyScoreBase * urgencyWeightMultiplier), 0, 100);

    const paymentScore = signals.hasPayment ? 100 : 0;
    const scarcityScore = signals.hasScarcity ? 100 : 0;

    // Domain risk is simulated: trusted domains are low risk, unknown domains medium.
    const domainRiskScore = trustedDomain ? 10 : 55;

    // External link risk: if the page contains links to other domains, add risk.
    const externalLinkScore = hasExternalLink ? 80 : 10;

    // Weighted model requested by you
    let risk =
      (0.30 * urgencyScore) +
      (0.35 * paymentScore) +
      (0.15 * scarcityScore) +
      (0.10 * domainRiskScore) +
      (0.10 * externalLinkScore);

    // False-positive reduction:
    // If:
    //  - Known domain
    //  - No payment request
    //  - Formal tone
    // Then reduce final score by 15%.
    const formalTone = hasFormalTone(text);
    const qualifiesFPReduction = trustedDomain && !signals.hasPayment && formalTone;
    if (qualifiesFPReduction) {
      risk -= 15;
    }

    risk = clamp(Math.round(risk), 0, 100);

    // Simulated confidence: more strong signals => higher confidence.
    const signalCount = [signals.hasUrgent, signals.hasImmediate, signals.hasScarcity, signals.hasPayment, hasExternalLink].filter(Boolean).length;
    const confidence = clamp(62 + (signalCount * 7) + (trustedDomain ? 6 : 0), 55, 95);

    // Trust indicators
    const primaryExternalDomain = externalDomains[0] || '';
    const externalDomainYesNo = hasExternalLink ? 'Yes' : 'No';
    const domainAge = primaryExternalDomain ? simulateDomainAgeLabel(primaryExternalDomain) : simulateDomainAgeLabel(host || 'unknown');
    const senderVerified = trustedDomain ? 'Yes' : 'No';

    // Contribution breakdown (display in a human-friendly way)
    const breakdown = [];
    if (signals.hasUrgent || signals.hasImmediate) breakdown.push({ value: Math.round(0.30 * urgencyScore), label: 'Urgency detected' });
    if (signals.hasPayment) breakdown.push({ value: Math.round(0.35 * paymentScore), label: 'Payment request detected' });
    if (signals.hasScarcity) breakdown.push({ value: Math.round(0.15 * scarcityScore), label: 'Scarcity language detected' });
    breakdown.push({ value: Math.round(0.10 * domainRiskScore), label: 'Domain risk signal' });
    breakdown.push({ value: Math.round(0.10 * externalLinkScore), label: hasExternalLink ? 'External link detected' : 'No external link detected' });
    if (trustedDomain) breakdown.push({ value: -10, label: 'Known trusted domain' });
    if (qualifiesFPReduction) breakdown.push({ value: -15, label: 'False-positive reduction (formal + trusted + no payment)' });

    return {
      risk,
      confidence,
      signals,
      trustedDomain,
      externalDomains,
      trustIndicators: {
        externalDomain: externalDomainYesNo,
        domainAge,
        senderVerified
      },
      breakdown
    };
  }

  function analyzePage(text, urgencyWeightMultiplier) {
    const model = computeWeightedRiskModel(text, urgencyWeightMultiplier);

    // Keep the existing demo behavior: force a stable 70% for the demo email phrases.
    // This is useful for predictable demos.
    const hasUrgent = text.includes('urgent');
    const hasImmediate = text.includes('immediately') || text.includes('immediate');
    const hasLimitedTime = text.includes('limited time');
    const hasFee = text.includes('fee');

    const demoHit =
      (hasUrgent && hasImmediate && hasLimitedTime) ||
      (hasFee && hasImmediate && hasLimitedTime);

    if (demoHit) {
      return {
        ...model,
        risk: 70,
        confidence: 82,
        breakdown: [
          { value: 25, label: 'Urgency detected' },
          { value: 30, label: 'Payment request detected' },
          { value: 15, label: 'Scarcity language detected' },
          { value: -10, label: 'Known trusted domain' }
        ]
      };
    }

    return model;
  }

  // -----------------------------
  // 3) UI injection
  // -----------------------------

  // Root container
  const root = document.createElement('div');
  root.id = 'shieldx-root';

  // Floating action button (circle)
  const fab = document.createElement('div');
  fab.id = 'shieldx-fab';
  fab.setAttribute('role', 'button');
  fab.setAttribute('aria-label', 'Open ShieldX safety panel');
  fab.title = 'ShieldX';

  // Inline SVG shield icon (no assets needed)
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l7 4v6c0 5-3.5 9.4-7 10-3.5-.6-7-5-7-10V6l7-4zm0 3.1L7 7.7V12c0 3.8 2.6 7.2 5 7.9 2.4-.7 5-4.1 5-7.9V7.7l-5-2.6z"/>
    </svg>
  `;

  // Slide-in panel
  // IMPORTANT: On sites like Gmail, regular fixed elements can still appear "behind" modals.
  // Using <dialog> + showModal() places the panel in the browser "top layer", which typically
  // renders above site overlays.
  const panel = document.createElement('dialog');
  panel.id = 'shieldx-panel';

  panel.innerHTML = `
    <div id="shieldx-panel-inner">
      <div id="shieldx-panel-header">
        <div id="shieldx-title">
          <strong>ShieldX</strong>
          <span>Demo Mode – Rule-Based Prototype</span>
        </div>
        <button id="shieldx-close" type="button" aria-label="Close panel">✕</button>
      </div>

      <div id="shieldx-panel-body">
        <div id="shieldx-risk-top">
          <div id="shieldx-risk-meter">
            <div id="shieldx-ring-wrap">
              <svg id="shieldx-ring" viewBox="0 0 120 120" aria-hidden="true">
                <circle id="shieldx-ring-track" cx="60" cy="60" r="46" />
                <circle id="shieldx-ring-progress" cx="60" cy="60" r="46" />
              </svg>
              <div id="shieldx-ring-center">
                <div id="shieldx-score">0%</div>
              </div>
            </div>
            <div id="shieldx-confidence">Confidence: --%</div>
          </div>

          <div id="shieldx-risk-summary">
            <div id="shieldx-risk-level">Risk Level: --</div>
            <div id="shieldx-suggested-action">Suggested Action: --</div>
          </div>
        </div>

        <div class="shieldx-section" id="shieldx-trust">
          <h4>Domain Trust Indicators</h4>
          <div class="shieldx-kv">
            <div><span>External Domain</span><strong id="shieldx-external-domain">--</strong></div>
            <div><span>Domain Age</span><strong id="shieldx-domain-age">--</strong></div>
            <div><span>Sender Verified</span><strong id="shieldx-sender-verified">--</strong></div>
          </div>
        </div>

        <div class="shieldx-section" id="shieldx-why-matters">
          <h4>Why This Matters</h4>
          <div id="shieldx-why-box">
            Scam emails use urgency and payment pressure.
            Real internships never ask for upfront fees.
          </div>
        </div>

        <div class="shieldx-section" id="shieldx-reasons">
          <h4>Detection Reasons</h4>
          <ul id="shieldx-reason-list"></ul>
        </div>

        <div id="shieldx-actions">
          <button class="shieldx-btn" id="shieldx-mark-safe" type="button">Mark as Safe</button>
          <button class="shieldx-btn" id="shieldx-report" type="button">Report</button>
          <button class="shieldx-btn" id="shieldx-learn-why" type="button">Learn Why</button>
          <button class="shieldx-btn" id="shieldx-clear-feedback" type="button">Clear Feedback</button>
        </div>

        <div id="shieldx-toast"></div>

        <div id="shieldx-tip"></div>
      </div>
    </div>
  `;

  // Attach elements to the page
  // Keep the floating button in its own fixed root.
  root.appendChild(fab);

  // Append as the LAST element in <body> so we win DOM-order ties.
  const host = (document.body || document.documentElement);
  host.appendChild(root);
  host.appendChild(panel);

  // -----------------------------
  // 4) UI state + rendering
  // -----------------------------

  // This object represents what we're currently showing in the UI.
  const state = {
    reasons: [],
    risk: 0,
    confidence: 0,
    suggestedAction: '',
    trustIndicators: {
      externalDomain: '--',
      domainAge: '--',
      senderVerified: '--'
    },
    breakdown: [],
    urgencyWeightMultiplier: DEFAULT_URGENCY_WEIGHT_MULTIPLIER,
    tipIndex: 0
  };

  const TIPS = [
    'Tip: Always verify internships through official websites.',
    'Tip: Never pay upfront fees for “verification” or “registration”.',
    'Tip: Check the sender domain carefully before clicking links.'
  ];

  function formatSignedPercent(n) {
    const sign = n > 0 ? '+' : '';
    return `${sign}${n}%`;
  }

  function loadLearningWeights(callback) {
    try {
      chrome.storage.local.get([URGENCY_WEIGHT_STORAGE_KEY], (res) => {
        const raw = res ? res[URGENCY_WEIGHT_STORAGE_KEY] : undefined;
        const val = typeof raw === 'number' ? raw : DEFAULT_URGENCY_WEIGHT_MULTIPLIER;
        state.urgencyWeightMultiplier = clamp(val, 0.7, 1.2);
        callback();
      });
    } catch (_) {
      state.urgencyWeightMultiplier = DEFAULT_URGENCY_WEIGHT_MULTIPLIER;
      callback();
    }
  }

  function saveLearningWeights() {
    try {
      chrome.storage.local.set({ [URGENCY_WEIGHT_STORAGE_KEY]: state.urgencyWeightMultiplier });
    } catch (_) {
      // Ignore
    }
  }

  function setTip() {
    const tipEl = document.getElementById('shieldx-tip');
    if (!tipEl) return;
    const tip = TIPS[state.tipIndex % TIPS.length];
    tipEl.textContent = tip;
    state.tipIndex = (state.tipIndex + 1) % TIPS.length;
  }

  function getRiskClass(score) {
    const bucket = getRiskColorBucket(score);
    if (bucket === 'green') return 'shieldx-risk-green';
    if (bucket === 'yellow') return 'shieldx-risk-yellow';
    return 'shieldx-risk-red';
  }

  function animateRingTo(targetScore) {
    const ring = document.getElementById('shieldx-ring-progress');
    const scoreEl = document.getElementById('shieldx-score');
    if (!ring || !scoreEl) return;

    const r = 46;
    const circumference = 2 * Math.PI * r;
    ring.style.strokeDasharray = `${circumference}`;

    const start = 0;
    const end = clamp(targetScore, 0, 100);
    const durationMs = 700;
    const startTs = performance.now();

    function tick(now) {
      const t = clamp((now - startTs) / durationMs, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = Math.round(start + (end - start) * eased);
      const offset = circumference - (circumference * val / 100);
      ring.style.strokeDashoffset = `${offset}`;
      scoreEl.textContent = `${val}%`;

      if (t < 1) {
        requestAnimationFrame(tick);
      }
    }

    ring.style.strokeDashoffset = `${circumference}`;
    requestAnimationFrame(tick);
  }

  function setToast(message) {
    const toast = document.getElementById('shieldx-toast');
    if (!toast) return;

    if (!message) {
      toast.classList.remove('shieldx-show');
      toast.textContent = '';
      return;
    }

    toast.textContent = message;
    toast.classList.add('shieldx-show');
  }

  function render() {
    const levelEl = document.getElementById('shieldx-risk-level');
    const listEl = document.getElementById('shieldx-reason-list');
    const confidenceEl = document.getElementById('shieldx-confidence');
    const suggestedActionEl = document.getElementById('shieldx-suggested-action');

    const extEl = document.getElementById('shieldx-external-domain');
    const ageEl = document.getElementById('shieldx-domain-age');
    const verifiedEl = document.getElementById('shieldx-sender-verified');

    const ringWrap = document.getElementById('shieldx-risk-meter');

    if (!levelEl || !listEl || !confidenceEl || !suggestedActionEl || !extEl || !ageEl || !verifiedEl || !ringWrap) return;

    // Update risk level text
    const level = getRiskLevel(state.risk);
    levelEl.textContent = `Risk Level: ${level}`;

    // Confidence
    confidenceEl.textContent = `Confidence: ${state.confidence}%`;

    // Suggested action
    suggestedActionEl.textContent = `Suggested Action: ${state.suggestedAction}`;

    // Apply color coding
    const colorClass = getRiskClass(state.risk);

    ringWrap.classList.remove('shieldx-risk-green', 'shieldx-risk-yellow', 'shieldx-risk-red', 'shieldx-glow');
    levelEl.classList.remove('shieldx-risk-green', 'shieldx-risk-yellow', 'shieldx-risk-red');

    ringWrap.classList.add(colorClass);
    levelEl.classList.add(colorClass);

    if (state.risk > 65) {
      ringWrap.classList.add('shieldx-glow');
    }

    // Domain trust indicators
    extEl.textContent = state.trustIndicators.externalDomain;
    ageEl.textContent = state.trustIndicators.domainAge;
    verifiedEl.textContent = state.trustIndicators.senderVerified;

    // Render reasons
    listEl.innerHTML = '';

    if (!state.reasons.length) {
      const li = document.createElement('li');
      li.textContent = 'No obvious scam keywords found (demo rules).';
      listEl.appendChild(li);
      return;
    }

    for (const reason of state.reasons) {
      const li = document.createElement('li');
      li.textContent = reason;
      listEl.appendChild(li);
    }
  }

  function computeAndSetState() {
    const text = getSearchText();
    const result = analyzePage(text, state.urgencyWeightMultiplier);

    state.risk = result.risk;
    state.confidence = result.confidence;
    state.suggestedAction = getSuggestedAction(result.risk);
    state.trustIndicators = result.trustIndicators;
    state.breakdown = result.breakdown;

    // Human-readable reasons
    const reasons = [];
    if (result.signals.hasUrgent) reasons.push('Urgency language detected');
    if (result.signals.hasImmediate) reasons.push('Immediate response pressure detected');
    if (result.signals.hasScarcity) reasons.push('Scarcity language detected');
    if (result.signals.hasPayment) reasons.push('Payment / fee request detected');
    if (result.externalDomains.length) reasons.push(`External link domain: ${result.externalDomains[0]}`);
    state.reasons = reasons;

    render();
    animateRingTo(state.risk);
    setTip();
  }

  // Initial scan (after loading any learned weights)
  loadLearningWeights(() => {
    computeAndSetState();
  });

  // -----------------------------
  // 5) Interactions
  // -----------------------------

  function openPanel() {
    // Re-scan on open so dynamic apps (like Gmail) get the latest text.
    computeAndSetState();

    // If <dialog> is supported, show it in the browser top-layer.
    if (typeof panel.showModal === 'function') {
      if (!panel.open) panel.showModal();
    }

    panel.classList.add('shieldx-open');
    setToast('');
  }

  function closePanel() {
    panel.classList.remove('shieldx-open');

    // Close the dialog after the slide-out animation finishes.
    if (typeof panel.close === 'function') {
      window.setTimeout(() => {
        if (panel.open) panel.close();
      }, 260);
    }

    setToast('');
  }

  // Clicking the floating button toggles the panel
  fab.addEventListener('click', () => {
    const isOpen = panel.classList.contains('shieldx-open');
    if (isOpen) closePanel();
    else openPanel();
  });

  // Close button
  const closeBtn = document.getElementById('shieldx-close');
  closeBtn.addEventListener('click', closePanel);

  // Mark as Safe (learning simulation)
  const markSafeBtn = document.getElementById('shieldx-mark-safe');
  markSafeBtn.addEventListener('click', () => {
    // Simulated adaptive behavior:
    // Reduce the urgency weight slightly to reduce false positives going forward.
    state.urgencyWeightMultiplier = clamp(state.urgencyWeightMultiplier - 0.05, 0.7, 1.2);
    saveLearningWeights();

    computeAndSetState();
    setToast('Feedback recorded. Model weights adjusted.');
  });

  // Report button (demo only)
  const reportBtn = document.getElementById('shieldx-report');
  reportBtn.addEventListener('click', () => {
    setToast('Report submitted (demo). No data was sent anywhere.');
  });

  // Learn Why button (demo only)
  const learnWhyBtn = document.getElementById('shieldx-learn-why');
  learnWhyBtn.addEventListener('click', () => {
    setToast('Urgency and immediate response patterns detected.\nSuch tactics are commonly used in scam campaigns to create pressure.');
  });

  // Clear Feedback (delete stored learning so the widget goes back to live scanning)
  const clearFeedbackBtn = document.getElementById('shieldx-clear-feedback');
  clearFeedbackBtn.addEventListener('click', () => {
    // Reset stored learning
    try {
      chrome.storage.local.remove([URGENCY_WEIGHT_STORAGE_KEY]);
    } catch (_) {
      // Ignore
    }

    state.urgencyWeightMultiplier = DEFAULT_URGENCY_WEIGHT_MULTIPLIER;
    computeAndSetState();
    setToast('Feedback cleared. Back to live scanning.');
  });

  // Note: We intentionally do NOT restore feedback from storage in this demo.
  // This keeps the demo deterministic across reloads.
})();
