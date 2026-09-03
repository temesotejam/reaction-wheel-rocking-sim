(() => {
  "use strict";

  const G = 9.80665;
  const DEG = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const TWO_PI = 2 * Math.PI;

  // Current-response model identified in study_AT (7.5 V reference).
  const I_SAT_MA = 329.547;
  const P_SAT = 3.86;
  const TAU_RISE_MIN_MS = 31.4;
  const TAU_RISE_MAX_MS = 72.8;
  const U_TAU_MA = 372.0;
  const Q_TAU = 4.35;

  const els = {};
  const ids = [
    "statusBadge", "motionCanvas", "timeChart", "sweepChart", "playBtn", "restartBtn", "speedSelect",
    "runBtn", "qSweepBtn", "stateSweepBtn", "initialDeg", "targetDeg", "qMas", "currentMa",
    "energyAction", "simSeconds", "massKg", "icg", "viscous", "coulomb", "kt", "jw", "maxRpm",
    "dtMs", "tauFallMs", "validationMsg",
    "liveT", "liveTheta", "liveOmega", "liveICmd", "liveIActual", "liveQ", "liveWheelAngle", "liveRpm", "liveMode",
    "metricPeakQ", "metricPeak0", "metricDeltaE", "metricQeff", "metricWheel", "metricTargetErr",
    "sweepTitle", "sweepSubtitle", "sweepSummary"
  ];
  ids.forEach(id => { els[id] = document.getElementById(id); });

  let activePair = null;
  let activeParams = null;
  let playing = false;
  let playbackTime = 0;
  let lastFrameTs = 0;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function finiteOr(v, fallback) { return Number.isFinite(v) ? v : fallback; }
  function rpmFromRadS(w) { return w * 60 / TWO_PI; }

  function currentGoalMa(commandMa) {
    const u = Math.abs(commandMa);
    if (u < 1e-12) return 0;
    return u / Math.pow(1 + Math.pow(u / I_SAT_MA, P_SAT), 1 / P_SAT);
  }

  function tauRiseS(commandMa) {
    const u = Math.abs(commandMa);
    const tauMs = TAU_RISE_MIN_MS +
      (TAU_RISE_MAX_MS - TAU_RISE_MIN_MS) /
      (1 + Math.pow(u / U_TAU_MA, Q_TAU));
    return tauMs / 1000;
  }

  function qOnForWidth(i0Ma, commandMa, widthS) {
    const sign = Math.sign(commandMa) || 1;
    const goal = sign * currentGoalMa(commandMa);
    const tau = tauRiseS(commandMa);
    const signedQ = goal * widthS + (i0Ma - goal) * tau * (1 - Math.exp(-widthS / tau));
    return Math.abs(signedQ);
  }

  function solvePulseWidthS(qTargetMas, i0Ma, commandMa) {
    if (qTargetMas <= 0 || Math.abs(commandMa) < 1e-12) return 0;
    let lo = 0;
    let hi = 0.005;
    while (qOnForWidth(i0Ma, commandMa, hi) < qTargetMas && hi < 0.25) hi *= 2;
    hi = Math.min(hi, 0.25);
    if (qOnForWidth(i0Ma, commandMa, hi) < qTargetMas) return hi;
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi);
      if (qOnForWidth(i0Ma, commandMa, mid) < qTargetMas) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  function readParams() {
    const p = {
      initialDeg: finiteOr(parseFloat(els.initialDeg.value), 8),
      targetDeg: finiteOr(parseFloat(els.targetDeg.value), 10),
      qMas: Math.max(0, finiteOr(parseFloat(els.qMas.value), 1)),
      currentMa: Math.max(1, finiteOr(parseFloat(els.currentMa.value), 300)),
      energyAction: els.energyAction.value,
      simSeconds: clamp(finiteOr(parseFloat(els.simSeconds.value), 6), 1, 15),
      mass: Math.max(0.001, finiteOr(parseFloat(els.massKg.value), 0.1997)),
      icg: Math.max(1e-8, finiteOr(parseFloat(els.icg.value), 0.00055)),
      viscous: Math.max(0, finiteOr(parseFloat(els.viscous.value), 0.00012)),
      coulomb: Math.max(0, finiteOr(parseFloat(els.coulomb.value), 0.00005)),
      kt: Math.max(1e-7, finiteOr(parseFloat(els.kt.value), 0.05)),
      jw: Math.max(1e-9, finiteOr(parseFloat(els.jw.value), 0.00008)),
      maxRpm: Math.max(1, finiteOr(parseFloat(els.maxRpm.value), 6000)),
      dt: clamp(finiteOr(parseFloat(els.dtMs.value), 0.2), 0.02, 2) / 1000,
      tauFall: Math.max(0.001, finiteOr(parseFloat(els.tauFallMs.value), 73.0) / 1000),
      radius: 0.150,
      innerX: 0.005,
      outerX: 0.045,
      h: 0.120,
      omegaFrictionEps: 0.03
    };
    p.thetaInner = Math.asin(p.innerX / p.radius);
    p.thetaOuter = Math.asin(p.outerX / p.radius);
    p.hC0 = Math.sqrt(p.radius * p.radius - p.innerX * p.innerX);
    p.d = p.hC0 - p.h;
    p.maxWheelRadS = p.maxRpm * TWO_PI / 60;
    return p;
  }

  function validateParams(p) {
    const msgs = [];
    if (p.initialDeg <= 0 || p.initialDeg >= p.thetaOuter * RAD2DEG) {
      msgs.push(`初期振幅は 0〜${(p.thetaOuter * RAD2DEG).toFixed(2)}° 未満にしてください。`);
    }
    if (p.targetDeg <= 0 || p.targetDeg > p.thetaOuter * RAD2DEG) {
      msgs.push(`目標角は ${(p.thetaOuter * RAD2DEG).toFixed(2)}° 以下にしてください。`);
    }
    const w = solvePulseWidthS(p.qMas, 0, p.currentMa);
    if (w > 0.05) msgs.push(`現在の電流モデルではQ指令に必要なON幅が ${(w * 1000).toFixed(1)} ms です。`);
    if (p.dt > 0.001 && p.qMas > 0) msgs.push("短パルスを見るには dt ≤ 1 ms を推奨します。");
    return msgs;
  }

  function contactMode(theta, p) {
    const a = Math.abs(theta);
    if (a < 1e-9) return "double_inner_edge";
    if (a < p.thetaInner) return "single_inner_edge_pivot";
    if (a <= p.thetaOuter) return "circular_arc";
    return "outside_model";
  }

  function deltaHeight(theta, p) {
    const a = Math.abs(theta);
    if (a <= p.thetaInner) return p.h * (Math.cos(a) - 1) + p.innerX * Math.sin(a);
    return p.radius - p.d * Math.cos(theta) - p.h;
  }

  function dHeightDTheta(theta, omega, p) {
    const a = Math.abs(theta);
    let s = Math.sign(theta);
    if (s === 0) s = Math.sign(omega);
    if (s === 0) return 0;
    if (a <= p.thetaInner) return s * (-p.h * Math.sin(a) + p.innerX * Math.cos(a));
    return p.d * Math.sin(theta);
  }

  function effectiveInertia(theta, p) {
    const a = Math.abs(theta);
    if (a <= p.thetaInner) return p.icg + p.mass * (p.h * p.h + p.innerX * p.innerX);
    return p.icg + p.mass * (p.radius * p.radius + p.d * p.d - 2 * p.radius * p.d * Math.cos(theta));
  }

  function inertiaDerivative(theta, p) {
    if (Math.abs(theta) <= p.thetaInner) return 0;
    return 2 * p.mass * p.radius * p.d * Math.sin(theta);
  }

  function potential(theta, p) { return p.mass * G * deltaHeight(theta, p); }

  function rockEnergy(theta, omega, p) {
    return 0.5 * effectiveInertia(theta, p) * omega * omega + potential(theta, p);
  }

  function frictionTorque(omega, p) {
    return p.viscous * omega + p.coulomb * Math.tanh(omega / p.omegaFrictionEps);
  }

  function acceleration(theta, omega, tauMotor, p) {
    const j = effectiveInertia(theta, p);
    const jp = inertiaDerivative(theta, p);
    const du = p.mass * G * dHeightDTheta(theta, omega, p);
    return (-0.5 * jp * omega * omega - du - frictionTorque(omega, p) - tauMotor) / j;
  }

  function rk4Body(theta, omega, tau, dt, p) {
    const a1 = acceleration(theta, omega, tau, p);
    const th2 = theta + 0.5 * dt * omega;
    const om2 = omega + 0.5 * dt * a1;
    const a2 = acceleration(th2, om2, tau, p);
    const th3 = theta + 0.5 * dt * om2;
    const om3 = omega + 0.5 * dt * a2;
    const a3 = acceleration(th3, om3, tau, p);
    const th4 = theta + dt * om3;
    const om4 = omega + dt * a3;
    const a4 = acceleration(th4, om4, tau, p);
    return {
      theta: theta + dt * (omega + 2 * om2 + 2 * om3 + om4) / 6,
      omega: omega + dt * (a1 + 2 * a2 + 2 * a3 + a4) / 6
    };
  }

  function simulate(p, pulseEnabled, qOverride = null) {
    const qCommand = qOverride == null ? p.qMas : Math.max(0, qOverride);
    const dt = p.dt;
    const maxSteps = Math.ceil(p.simSeconds / dt);
    const sampleEvery = Math.max(1, Math.round(0.002 / dt));

    let t = 0;
    let theta = p.initialDeg * DEG;
    let omega = 0;
    let wheelOmega = 0;
    let wheelAngle = 0;
    let currentActualMa = 0;
    let currentCmdMa = 0;
    let qOn = 0;
    let qTotal = 0;

    let pulseTriggered = false;
    let pulseFinished = !pulseEnabled || qCommand === 0;
    let pulseStart = NaN;
    let pulseEnd = NaN;
    let pulseWidth = 0;
    let cmdSign = 0;
    let nextPeak = null;
    let crossed = false;
    let lastTheta = theta;
    let lastOmega = omega;
    let maxWheelRpm = 0;
    let saturated = false;
    let invalid = false;
    let bodyMotorWork = 0;
    let motorWork = 0;
    let lossWork = 0;
    const samples = [];

    function pushSample(tau) {
      samples.push({
        t, theta, omega, wheelOmega, wheelAngle,
        currentCmdMa, currentActualMa, qOn, qTotal,
        energy: rockEnergy(theta, omega, p),
        mode: contactMode(theta, p), tau
      });
    }

    pushSample(0);

    for (let step = 0; step < maxSteps; step++) {
      if (pulseEnabled && pulseTriggered && !pulseFinished && t < pulseEnd - 0.5 * dt) {
        currentCmdMa = cmdSign * p.currentMa;
      } else {
        currentCmdMa = 0;
      }

      const iOld = currentActualMa;
      if (Math.abs(currentCmdMa) > 1e-12) {
        const goal = Math.sign(currentCmdMa) * currentGoalMa(currentCmdMa);
        const a = Math.exp(-dt / tauRiseS(currentCmdMa));
        currentActualMa = goal + (currentActualMa - goal) * a;
      } else {
        currentActualMa *= Math.exp(-dt / p.tauFall);
      }
      const iMid = 0.5 * (iOld + currentActualMa);

      if (Math.abs(currentCmdMa) > 1e-12) qOn += Math.abs(iMid) * dt;
      if (pulseTriggered) qTotal += Math.abs(iMid) * dt;

      let tau = p.kt * (iMid / 1000);
      const wouldIncreaseWheel = wheelOmega === 0 || Math.sign(tau) === Math.sign(wheelOmega);
      if (Math.abs(wheelOmega) >= p.maxWheelRadS && wouldIncreaseWheel) {
        tau = 0;
        saturated = true;
      }

      const bodyOldOmega = omega;
      const wheelOldOmega = wheelOmega;
      const next = rk4Body(theta, omega, tau, dt, p);
      theta = next.theta;
      omega = next.omega;

      wheelOmega += (tau / p.jw) * dt;
      if (Math.abs(wheelOmega) > p.maxWheelRadS) {
        wheelOmega = Math.sign(wheelOmega) * p.maxWheelRadS;
        saturated = true;
      }
      wheelAngle += 0.5 * (wheelOldOmega + wheelOmega) * dt;

      const omegaMid = 0.5 * (bodyOldOmega + omega);
      const wheelMid = 0.5 * (wheelOldOmega + wheelOmega);
      bodyMotorWork += (-tau * omegaMid) * dt;
      motorWork += tau * (wheelMid - omegaMid) * dt;
      lossWork += frictionTorque(omegaMid, p) * omegaMid * dt;

      t += dt;

      if (!crossed && lastTheta * theta <= 0 && Math.abs(lastTheta - theta) > 1e-12 && t > 2 * dt) {
        crossed = true;
        if (pulseEnabled && qCommand > 0) {
          pulseTriggered = true;
          pulseStart = t;
          const bodyDesiredSign = p.energyAction === "add" ? Math.sign(omega) : -Math.sign(omega);
          const wheelTorqueSign = -bodyDesiredSign || -1;
          cmdSign = wheelTorqueSign;
          pulseWidth = solvePulseWidthS(qCommand, currentActualMa, cmdSign * p.currentMa);
          pulseEnd = pulseStart + pulseWidth;
          pulseFinished = false;
        } else {
          pulseTriggered = true;
          pulseStart = t;
          pulseEnd = t;
          pulseFinished = true;
        }
      }

      if (pulseEnabled && pulseTriggered && !pulseFinished && t >= pulseEnd) {
        pulseFinished = true;
      }

      const canLookForPeak = crossed && pulseTriggered && t > pulseStart + 2 * dt;
      if (!nextPeak && canLookForPeak && lastOmega * omega <= 0 && Math.abs(theta) > 0.2 * DEG && Math.abs(lastOmega - omega) > 1e-10) {
        nextPeak = {
          t, theta, amplitudeDeg: Math.abs(theta) * RAD2DEG,
          energy: rockEnergy(theta, omega, p),
          qOn, qTotal, currentActualMa, wheelOmega, wheelAngle
        };
      }

      maxWheelRpm = Math.max(maxWheelRpm, Math.abs(rpmFromRadS(wheelOmega)));

      if (Math.abs(theta) > p.thetaOuter + 0.02 * DEG) {
        invalid = true;
        if (step % sampleEvery !== 0) pushSample(tau);
        break;
      }

      if (step % sampleEvery === 0) pushSample(tau);
      lastTheta = theta;
      lastOmega = omega;
    }

    return {
      samples, nextPeak, qOn, qTotal, pulseWidth,
      maxWheelRpm, saturated, invalid, pulseTriggered, pulseStart, pulseEnd, qCommand,
      bodyMotorWork, motorWork, lossWork,
      status: invalid ? "outside_model" : (!crossed ? "no_zero_cross" : (!nextPeak ? "no_next_peak" : "ok"))
    };
  }

  function runPair(p, qOverride = null) {
    const pulse = simulate(p, true, qOverride);
    const baseline = simulate(p, false, 0);
    const deltaE = pulse.nextPeak && baseline.nextPeak ? pulse.nextPeak.energy - baseline.nextPeak.energy : NaN;
    return { pulse, baseline, deltaE, targetEnergy: potential(p.targetDeg * DEG, p) };
  }

  function setStatus(pair) {
    let text = "OK";
    let color = "#7ee0b8";
    if (pair.pulse.invalid || pair.baseline.invalid) { text = "MODEL LIMIT"; color = "#ff7474"; }
    else if (pair.pulse.saturated) { text = "WHEEL LIMIT"; color = "#ffd166"; }
    else if (pair.pulse.status !== "ok") { text = pair.pulse.status.toUpperCase(); color = "#ffd166"; }
    els.statusBadge.textContent = text;
    els.statusBadge.style.color = color;
    els.statusBadge.style.borderColor = color;
  }

  function updateMetrics(pair) {
    const ppk = pair.pulse.nextPeak;
    const bpk = pair.baseline.nextPeak;
    els.metricPeakQ.textContent = ppk ? ppk.amplitudeDeg.toFixed(3) : "—";
    els.metricPeak0.textContent = bpk ? bpk.amplitudeDeg.toFixed(3) : "—";
    els.metricDeltaE.textContent = Number.isFinite(pair.deltaE) ? (pair.deltaE * 1000).toFixed(4) : "—";
    els.metricQeff.textContent = ppk ? ppk.qOn.toFixed(3) : pair.pulse.qOn.toFixed(3);
    els.metricWheel.textContent = pair.pulse.maxWheelRpm.toFixed(0);
    els.metricTargetErr.textContent = ppk ? (ppk.amplitudeDeg - activeParams.targetDeg).toFixed(3) : "—";
  }

  function prettyMode(mode) {
    if (mode === "double_inner_edge") return "両内側端 接地";
    if (mode === "single_inner_edge_pivot") return "内側端点 支点";
    if (mode === "circular_arc") return "円弧 転がり";
    return "モデル範囲外";
  }

  function wheelDirLabel(w) {
    if (w > 1e-3) return "CCW";
    if (w < -1e-3) return "CW";
    return "STOP";
  }

  function drawRotationArrow(ctx, cx, cy, r, dir, color, width = 3) {
    if (!dir) return;
    const start = dir > 0 ? -0.55 : 0.55;
    const span = dir * 1.85;
    const n = 30;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = start + span * i / n;
      const x = cx + r * Math.cos(a);
      const y = cy - r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.stroke();

    const a = start + span;
    const tipX = cx + r * Math.cos(a);
    const tipY = cy - r * Math.sin(a);
    const tx = -Math.sin(a) * dir;
    const ty = -Math.cos(a) * dir;
    const nx = -ty;
    const ny = tx;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - tx * 10 + nx * 5, tipY - ty * 10 + ny * 5);
    ctx.lineTo(tipX - tx * 10 - nx * 5, tipY - ty * 10 - ny * 5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function bodyContactPoint(theta, p) {
    const mag = Math.abs(theta);
    if (mag < 1e-9) return { x: 0, z: 0 };
    if (mag < p.thetaInner) return { x: theta > 0 ? -p.innerX : p.innerX, z: 0 };
    return { x: -p.radius * Math.sin(theta), z: p.hC0 - p.radius * Math.cos(theta) };
  }

  function bodyPose(theta, p) {
    const mag = Math.abs(theta);
    if (mag < 1e-9) return { x: 0, z: 0, contactX: 0 };
    const side = Math.sign(theta);
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    if (mag < p.thetaInner) {
      const pivotBodyX = side > 0 ? -p.innerX : p.innerX;
      const pivotWorldX = pivotBodyX;
      return {
        x: pivotWorldX - c * pivotBodyX,
        z: -s * pivotBodyX,
        contactX: pivotWorldX
      };
    }

    const contactWorldX = -side * (p.innerX + p.radius * (mag - p.thetaInner));
    return {
      x: contactWorldX + p.hC0 * s,
      z: p.radius - p.hC0 * c,
      contactX: contactWorldX
    };
  }

  function transformBodyPoint(x, z, theta, p) {
    const pose = bodyPose(theta, p);
    const c = Math.cos(theta), s = Math.sin(theta);
    return { x: pose.x + c * x - s * z, z: pose.z + s * x + c * z };
  }

  function drawMotion(sample, p) {
    const canvas = els.motionCanvas;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#090e14";
    ctx.fillRect(0, 0, w, h);

    const groundY = h - 62;
    const originX = w * 0.5;
    const scale = Math.min(w / 0.48, h / 0.29);
    const sx = x => originX + x * scale;
    const sy = z => groundY - z * scale;

    ctx.strokeStyle = "#3a4654";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(25, groundY); ctx.lineTo(w - 25, groundY); ctx.stroke();
    ctx.strokeStyle = "#202a35";
    ctx.lineWidth = 1;
    for (let x = 40; x < w - 30; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, groundY + 1); ctx.lineTo(x - 13, groundY + 12); ctx.stroke();
    }

    ctx.strokeStyle = "#556474";
    ctx.beginPath(); ctx.moveTo(originX, groundY - 8); ctx.lineTo(originX, groundY + 8); ctx.stroke();

    const theta = sample.theta;
    function wp(x, z) {
      const q = transformBodyPoint(x, z, theta, p);
      return { x: sx(q.x), y: sy(q.z) };
    }

    function drawArcSegment(x0, x1) {
      ctx.beginPath();
      for (let i = 0; i <= 36; i++) {
        const x = x0 + (x1 - x0) * i / 36;
        const z = p.hC0 - Math.sqrt(Math.max(0, p.radius * p.radius - x * x));
        const q = wp(x, z);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = "#aab8c7";
      ctx.lineWidth = 8;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    drawArcSegment(-p.outerX, -p.innerX);
    drawArcSegment(p.innerX, p.outerX);

    const bodyPts = [wp(-0.022, 0.018), wp(0.022, 0.018), wp(0.024, 0.185), wp(-0.024, 0.185)];
    ctx.beginPath();
    bodyPts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
    ctx.closePath();
    ctx.fillStyle = "#344658"; ctx.fill();
    ctx.strokeStyle = "#7690aa"; ctx.lineWidth = 2; ctx.stroke();

    const crossL = wp(-0.070, 0.065), crossR = wp(0.070, 0.065);
    ctx.beginPath(); ctx.moveTo(crossL.x, crossL.y); ctx.lineTo(crossR.x, crossR.y);
    ctx.strokeStyle = "#5f7892"; ctx.lineWidth = 9; ctx.stroke();

    const wheelC = wp(0, 0.150);
    const wheelR = 0.032 * scale;
    const cmdOn = Math.abs(sample.currentCmdMa) > 1e-6;
    const wheelDirSign = sample.wheelOmega > 1e-3 ? 1 : (sample.wheelOmega < -1e-3 ? -1 : 0);
    const wheelDir = wheelDirLabel(sample.wheelOmega);

    ctx.beginPath(); ctx.arc(wheelC.x, wheelC.y, wheelR, 0, TWO_PI);
    ctx.fillStyle = "#19232e"; ctx.fill();
    ctx.strokeStyle = cmdOn ? "#7ee0b8" : "#68a8ff"; ctx.lineWidth = 4; ctx.stroke();

    for (let k = 0; k < 6; k++) {
      const a = sample.wheelAngle + k * TWO_PI / 6;
      ctx.beginPath(); ctx.moveTo(wheelC.x, wheelC.y);
      ctx.lineTo(wheelC.x + Math.cos(a) * wheelR * 0.85, wheelC.y - Math.sin(a) * wheelR * 0.85);
      ctx.strokeStyle = cmdOn ? "#9debc9" : "#4f80b5"; ctx.lineWidth = 2; ctx.stroke();
    }
    if (wheelDirSign) drawRotationArrow(ctx, wheelC.x, wheelC.y, wheelR + 14, wheelDirSign, wheelDirSign > 0 ? "#7ee0b8" : "#ffb86b");

    const cg = wp(0, p.h);
    ctx.beginPath(); ctx.arc(cg.x, cg.y, 7, 0, TWO_PI); ctx.fillStyle = "#ff6b6b"; ctx.fill();
    ctx.fillStyle = "#ff9b9b"; ctx.font = "12px system-ui"; ctx.fillText("CG", cg.x + 10, cg.y - 8);

    ctx.fillStyle = "#ffd166";
    if (Math.abs(theta) < 1e-9) {
      const qL = wp(-p.innerX, 0), qR = wp(p.innerX, 0);
      ctx.beginPath(); ctx.arc(qL.x, qL.y, 5, 0, TWO_PI); ctx.fill();
      ctx.beginPath(); ctx.arc(qR.x, qR.y, 5, 0, TWO_PI); ctx.fill();
    } else {
      const cpt = bodyContactPoint(theta, p), cq = wp(cpt.x, cpt.z);
      ctx.beginPath(); ctx.arc(cq.x, cq.y, 6, 0, TWO_PI); ctx.fill();
    }

    ctx.fillStyle = "#dce7f2"; ctx.font = "600 15px system-ui";
    ctx.fillText(`${(theta * RAD2DEG).toFixed(2)}°`, 20, 28);
    ctx.fillStyle = "#91a0b1"; ctx.font = "12px system-ui";
    ctx.fillText(prettyMode(sample.mode), 20, 48);
    ctx.fillStyle = cmdOn ? "#7ee0b8" : "#708090";
    ctx.fillText(cmdOn ? `CURRENT CMD ON  Qon=${sample.qOn.toFixed(3)} mA·s` :
      (Math.abs(sample.currentActualMa) > 1 ? "CMD OFF / current tail" : "CURRENT CMD OFF"), 20, 70);

    const panelW = 190, panelH = 154, panelX = w - panelW - 18, panelY = 16;
    ctx.fillStyle = "rgba(17,24,32,.92)";
    ctx.strokeStyle = "#33404e";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(panelX, panelY, panelW, panelH, 10);
    else ctx.rect(panelX, panelY, panelW, panelH);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = "#9fb0c1"; ctx.font = "12px system-ui";
    ctx.fillText("MOTOR / REACTION WHEEL", panelX + 12, panelY + 18);
    ctx.fillStyle = "#e7f1fb"; ctx.font = "700 20px system-ui";
    ctx.fillText(`${Math.abs(rpmFromRadS(sample.wheelOmega)).toFixed(0)} rpm`, panelX + 12, panelY + 45);
    ctx.font = "12px system-ui";
    ctx.fillStyle = "#9fb0c1";
    ctx.fillText(`Icmd : ${sample.currentCmdMa.toFixed(0)} mA`, panelX + 12, panelY + 67);
    ctx.fillText(`Iactual : ${sample.currentActualMa.toFixed(1)} mA`, panelX + 12, panelY + 85);
    ctx.fillText(`wheel dir : ${wheelDir}`, panelX + 12, panelY + 103);
    ctx.fillText(`wheel angle : ${(sample.wheelAngle * RAD2DEG).toFixed(1)}°`, panelX + 12, panelY + 121);
    ctx.fillText(`Qon : ${sample.qOn.toFixed(3)} mA·s`, panelX + 12, panelY + 139);
  }

  function sampleAtTime(samples, t) {
    if (!samples.length) return null;
    if (t <= samples[0].t) return samples[0];
    if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t < t) lo = mid; else hi = mid;
    }
    return Math.abs(samples[lo].t - t) < Math.abs(samples[hi].t - t) ? samples[lo] : samples[hi];
  }

  function updateLive(s) {
    if (!s) return;
    els.liveT.textContent = s.t.toFixed(3);
    els.liveTheta.textContent = (s.theta * RAD2DEG).toFixed(2);
    els.liveOmega.textContent = (s.omega * RAD2DEG).toFixed(1);
    els.liveICmd.textContent = s.currentCmdMa.toFixed(0);
    els.liveIActual.textContent = s.currentActualMa.toFixed(1);
    els.liveQ.textContent = s.qOn.toFixed(3);
    els.liveWheelAngle.textContent = (s.wheelAngle * RAD2DEG).toFixed(1);
    els.liveRpm.textContent = rpmFromRadS(s.wheelOmega).toFixed(0);
    els.liveMode.textContent = prettyMode(s.mode);
  }

  function drawStateHistory(pair, cursorT = null) {
    const canvas = els.timeChart, ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#090e14"; ctx.fillRect(0, 0, w, h);

    const samples = pair.pulse.samples;
    const base = pair.baseline.samples;
    const tMax = Math.max(samples[samples.length - 1]?.t || 1, 1);
    const left = 64, right = 18, top = 18, bottom = 28;
    const laneGap = 12;
    const laneH = (h - top - bottom - laneGap * 3) / 4;
    const X = t => left + t / tMax * (w - left - right);

    const lanes = [
      {
        title: "body θ [deg]",
        values: samples.map(s => s.theta * RAD2DEG),
        baseline: base.map(s => s.theta * RAD2DEG),
        baselineSamples: base,
        color: "#68a8ff"
      },
      {
        title: "current [mA]",
        values: samples.map(s => s.currentActualMa),
        second: samples.map(s => s.currentCmdMa),
        color: "#7ee0b8",
        secondColor: "#ffd166"
      },
      {
        title: "wheel speed [rpm]",
        values: samples.map(s => rpmFromRadS(s.wheelOmega)),
        color: "#ffb86b"
      },
      {
        title: "wheel angle [deg]",
        values: samples.map(s => s.wheelAngle * RAD2DEG),
        color: "#c89cff"
      }
    ];

    lanes.forEach((lane, idx) => {
      const y0 = top + idx * (laneH + laneGap);
      const vals = lane.values.concat(lane.second || [], lane.baseline || []).filter(Number.isFinite);
      let vMin = Math.min(...vals, 0), vMax = Math.max(...vals, 0);
      if (Math.abs(vMax - vMin) < 1e-9) { vMin -= 1; vMax += 1; }
      const pad = 0.08 * (vMax - vMin);
      vMin -= pad; vMax += pad;
      const Y = v => y0 + laneH - (v - vMin) / (vMax - vMin) * laneH;

      ctx.strokeStyle = "#26313e";
      ctx.lineWidth = 1;
      ctx.strokeRect(left, y0, w - left - right, laneH);
      ctx.fillStyle = "#91a0b1";
      ctx.font = "11px system-ui";
      ctx.fillText(lane.title, 7, y0 + 13);
      ctx.fillText(vMax.toFixed(Math.abs(vMax) < 10 ? 2 : 0), 7, y0 + 28);
      ctx.fillText(vMin.toFixed(Math.abs(vMin) < 10 ? 2 : 0), 7, y0 + laneH - 2);

      function line(values, lineSamples, color, dash = []) {
        ctx.beginPath();
        let started = false;
        values.forEach((v, i) => {
          const s = lineSamples[i];
          if (!s || !Number.isFinite(v)) return;
          const x = X(s.t), y = Y(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        });
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (lane.baseline) line(lane.baseline, lane.baselineSamples, "#71849a", [5, 4]);
      line(lane.values, samples, lane.color);
      if (lane.second) line(lane.second, samples, lane.secondColor, [5, 3]);
    });

    ctx.fillStyle = "#8292a3";
    ctx.font = "11px system-ui";
    for (let i = 0; i <= 6; i++) {
      const tt = tMax * i / 6;
      ctx.fillText(tt.toFixed(2), X(tt) - 10, h - 7);
    }
    ctx.fillText("t [s]", w - 45, h - 7);

    if (Number.isFinite(pair.pulse.pulseStart)) {
      const x = X(pair.pulse.pulseStart);
      ctx.strokeStyle = "#7ee0b8";
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h - bottom); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (Number.isFinite(pair.pulse.pulseEnd)) {
      const x = X(pair.pulse.pulseEnd);
      ctx.strokeStyle = "#ffd166";
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h - bottom); ctx.stroke();
      ctx.setLineDash([]);
    }

    if (Number.isFinite(cursorT)) {
      const x = X(clamp(cursorT, 0, tMax));
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h - bottom); ctx.stroke();
    }
  }

  function drawSweep(data, options) {
    const canvas = els.sweepChart, ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#090e14"; ctx.fillRect(0, 0, w, h);
    if (!data.length) return;
    const xs = data.map(d => d.x), ys = data.map(d => d.y).filter(Number.isFinite);
    if (!ys.length) return;
    let xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xp = Math.max(0.05 * (xMax - xMin || 1), 0.05);
    const yp = Math.max(0.12 * (yMax - yMin || 1), 0.01);
    xMin -= xp; xMax += xp; yMin -= yp; yMax += yp;
    const pad = { l: 52, r: 16, t: 18, b: 40 };
    const X = x => pad.l + (x - xMin) / (xMax - xMin || 1) * (w - pad.l - pad.r);
    const Y = y => h - pad.b - (y - yMin) / (yMax - yMin || 1) * (h - pad.t - pad.b);
    ctx.strokeStyle = "#26313e"; ctx.strokeRect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
    ctx.beginPath();
    let started = false;
    data.forEach(d => {
      if (!Number.isFinite(d.y)) return;
      if (!started) { ctx.moveTo(X(d.x), Y(d.y)); started = true; } else ctx.lineTo(X(d.x), Y(d.y));
    });
    ctx.strokeStyle = "#7ee0b8"; ctx.lineWidth = 2; ctx.stroke();
    data.forEach(d => {
      if (!Number.isFinite(d.y)) return;
      ctx.beginPath(); ctx.arc(X(d.x), Y(d.y), 4.5, 0, TWO_PI);
      ctx.fillStyle = d.invalid ? "#ff7474" : "#7ee0b8"; ctx.fill();
    });
    ctx.fillStyle = "#8292a3"; ctx.font = "11px system-ui";
    ctx.fillText(options.xLabel, w - 80, h - 12);
    ctx.save(); ctx.translate(12, 85); ctx.rotate(-Math.PI / 2); ctx.fillText(options.yLabel, 0, 0); ctx.restore();
  }

  function linearFit(points) {
    const v = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (v.length < 2) return null;
    const mx = v.reduce((s,p) => s+p.x,0)/v.length;
    const my = v.reduce((s,p) => s+p.y,0)/v.length;
    let sxx=0, sxy=0, sst=0, sse=0;
    v.forEach(p => { sxx+=(p.x-mx)**2; sxy+=(p.x-mx)*(p.y-my); });
    const slope=sxx?sxy/sxx:0, intercept=my-slope*mx;
    v.forEach(p => { const yhat=intercept+slope*p.x; sst+=(p.y-my)**2; sse+=(p.y-yhat)**2; });
    return { slope, intercept, r2: sst>0?1-sse/sst:1 };
  }

  function runMain() {
    const p = readParams();
    const msgs = validateParams(p);
    els.validationMsg.textContent = msgs.join(" ");
    if (msgs.some(m => m.startsWith("初期振幅"))) return;
    activeParams = p;
    activePair = runPair(p);
    playbackTime = 0;
    playing = false;
    els.playBtn.textContent = "▶ 再生";
    setStatus(activePair);
    updateMetrics(activePair);
    const s = activePair.pulse.samples[0];
    drawMotion(s, p);
    updateLive(s);
    drawStateHistory(activePair, 0);
  }

  function runQSweep() {
    const p = readParams();
    activeParams = p;
    const maxQ = Math.max(2.0, p.qMas * 1.8);
    const data = [];
    for (let i = 0; i < 13; i++) {
      const q = maxQ * i / 12;
      const pair = runPair(p, q);
      data.push({ x: q, y: Number.isFinite(pair.deltaE) ? pair.deltaE * 1000 : NaN, invalid: pair.pulse.invalid || pair.pulse.saturated });
    }
    drawSweep(data, { xLabel: "Q [mA·s]", yLabel: "ΔEobs [mJ]" });
    els.sweepTitle.textContent = "Q sweep";
    els.sweepSubtitle.textContent = `初期振幅 ${p.initialDeg.toFixed(1)}°、実電流モデルを含む。`;
    const fit = linearFit(data);
    if (fit) els.sweepSummary.innerHTML =
      `線形近似: ΔEobs = <strong>${fit.slope.toFixed(4)}</strong> Q + ${fit.intercept.toFixed(4)} mJ　R²=<strong>${fit.r2.toFixed(4)}</strong>`;
  }

  function runStateSweep() {
    const p = readParams();
    activeParams = p;
    const amps = [5, 7, 9, 12, 15].filter(a => a < p.thetaOuter * RAD2DEG);
    const data = [];
    const rows = [];
    amps.forEach(a => {
      const pp = { ...p, initialDeg: a };
      const pair = runPair(pp);
      const de = Number.isFinite(pair.deltaE) ? pair.deltaE * 1000 : NaN;
      data.push({ x: a, y: de, invalid: pair.pulse.invalid || pair.pulse.saturated });
      const cross = sampleAtTime(pair.pulse.samples, pair.pulse.pulseStart);
      rows.push({ a, de, crossRate: cross ? Math.abs(cross.omega) * RAD2DEG : NaN });
    });
    drawSweep(data, { xLabel: "A₀ [deg]", yLabel: "ΔEobs [mJ]" });
    els.sweepTitle.textContent = "初期振幅 sweep";
    els.sweepSubtitle.textContent = `Q=${p.qMas.toFixed(3)} mA·s、同じ実電流モデルで比較。`;
    els.sweepSummary.innerHTML = rows.map(r =>
      `${r.a}°: ${Number.isFinite(r.de) ? r.de.toFixed(4) : "—"} mJ @ ${Number.isFinite(r.crossRate) ? r.crossRate.toFixed(1) : "—"}°/s`
    ).join("　/　");
  }

  function animate(ts) {
    if (!activePair || !activeParams) { requestAnimationFrame(animate); return; }
    if (!lastFrameTs) lastFrameTs = ts;
    const dtReal = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;
    if (playing) {
      playbackTime += dtReal * (parseFloat(els.speedSelect.value) || 1);
      const endT = activePair.pulse.samples[activePair.pulse.samples.length - 1].t;
      if (playbackTime >= endT) {
        playbackTime = endT;
        playing = false;
        els.playBtn.textContent = "▶ 再生";
      }
    }
    const s = sampleAtTime(activePair.pulse.samples, playbackTime);
    drawMotion(s, activeParams);
    updateLive(s);
    drawStateHistory(activePair, playbackTime);
    requestAnimationFrame(animate);
  }

  els.runBtn.addEventListener("click", runMain);
  els.qSweepBtn.addEventListener("click", runQSweep);
  els.stateSweepBtn.addEventListener("click", runStateSweep);
  els.playBtn.addEventListener("click", () => {
    if (!activePair) runMain();
    playing = !playing;
    if (playing) {
      const endT = activePair.pulse.samples[activePair.pulse.samples.length - 1].t;
      if (playbackTime >= endT) playbackTime = 0;
    }
    els.playBtn.textContent = playing ? "Ⅱ 一時停止" : "▶ 再生";
  });
  els.restartBtn.addEventListener("click", () => {
    playbackTime = 0;
    playing = false;
    els.playBtn.textContent = "▶ 再生";
    if (activePair && activeParams) {
      const s = activePair.pulse.samples[0];
      drawMotion(s, activeParams);
      updateLive(s);
      drawStateHistory(activePair, 0);
    }
  });

  runMain();
  runQSweep();
  requestAnimationFrame(animate);
})();