(() => {
  "use strict";

  const G = 9.80665;
  const DEG = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const TWO_PI = 2 * Math.PI;

  const els = {};
  const ids = [
    "statusBadge", "motionCanvas", "timeChart", "sweepChart", "playBtn", "restartBtn", "speedSelect",
    "runBtn", "qSweepBtn", "stateSweepBtn", "initialDeg", "targetDeg", "qMas", "currentMa",
    "energyAction", "simSeconds", "massKg", "icg", "viscous", "coulomb", "kt", "jw", "maxRpm",
    "dtMs", "validationMsg", "liveT", "liveTheta", "liveOmega", "liveRpm", "liveMode",
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
  function radSFromRpm(rpm) { return rpm * TWO_PI / 60; }

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
    p.maxWheelRadS = radSFromRpm(p.maxRpm);
    p.pulseDuration = p.qMas / p.currentMa;
    return p;
  }

  function validateParams(p) {
    const msgs = [];
    if (p.initialDeg <= 0 || p.initialDeg >= p.thetaOuter * RAD2DEG) msgs.push(`初期振幅は 0〜${(p.thetaOuter * RAD2DEG).toFixed(2)}° 未満にしてください。`);
    if (p.targetDeg <= 0 || p.targetDeg > p.thetaOuter * RAD2DEG) msgs.push(`目標角は ${(p.thetaOuter * RAD2DEG).toFixed(2)}° 以下にしてください。`);
    if (p.pulseDuration > 0.05) msgs.push("Q/電流から得たパルス幅が50 msを超えています。短パルス近似から外れます。");
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

  function potential(theta, p) {
    return p.mass * G * deltaHeight(theta, p);
  }

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
    const k1t = omega;
    const k1w = a1;

    const th2 = theta + 0.5 * dt * k1t;
    const om2 = omega + 0.5 * dt * k1w;
    const a2 = acceleration(th2, om2, tau, p);
    const k2t = om2;
    const k2w = a2;

    const th3 = theta + 0.5 * dt * k2t;
    const om3 = omega + 0.5 * dt * k2w;
    const a3 = acceleration(th3, om3, tau, p);
    const k3t = om3;
    const k3w = a3;

    const th4 = theta + dt * k3t;
    const om4 = omega + dt * k3w;
    const a4 = acceleration(th4, om4, tau, p);
    const k4t = om4;
    const k4w = a4;

    return {
      theta: theta + dt * (k1t + 2 * k2t + 2 * k3t + k4t) / 6,
      omega: omega + dt * (k1w + 2 * k2w + 2 * k3w + k4w) / 6
    };
  }

  function simulate(p, pulseEnabled, qOverride = null) {
    const qCommand = qOverride == null ? p.qMas : Math.max(0, qOverride);
    const pulseDuration = qCommand / p.currentMa;
    const currentA = p.currentMa / 1000;
    const tauMagnitude = p.kt * currentA;
    const dt = p.dt;
    const maxSteps = Math.ceil(p.simSeconds / dt);
    const sampleEvery = Math.max(1, Math.round(0.002 / dt));

    let t = 0;
    let theta = p.initialDeg * DEG;
    let omega = 0;
    let wheelOmega = 0;
    let wheelAngle = 0;
    let pulseTriggered = false;
    let pulseFinished = !pulseEnabled || qCommand === 0;
    let pulseStart = NaN;
    let pulseEnd = NaN;
    let tauSign = 0;
    let qEffective = 0;
    let bodyMotorWork = 0;
    let motorWork = 0;
    let lossWork = 0;
    let maxWheelRpm = 0;
    let saturated = false;
    let invalid = false;
    let triggerEnergy = NaN;
    let pulseEndEnergy = NaN;
    let nextPeak = null;
    let crossed = false;
    let lastTheta = theta;
    let lastOmega = omega;
    const samples = [];

    function pushSample(tau) {
      samples.push({ t, theta, omega, wheelOmega, wheelAngle, energy: rockEnergy(theta, omega, p), mode: contactMode(theta, p), tau, qEffective });
    }

    pushSample(0);

    for (let step = 0; step < maxSteps; step++) {
      let tau = 0;
      if (pulseEnabled && pulseTriggered && !pulseFinished && t < pulseStart + pulseDuration - 0.5 * dt) {
        tau = tauSign * tauMagnitude;
        const wouldIncreaseWheel = wheelOmega === 0 || Math.sign(tau) === Math.sign(wheelOmega);
        if (Math.abs(wheelOmega) >= p.maxWheelRadS && wouldIncreaseWheel) {
          tau = 0;
          saturated = true;
        }
      }

      const bodyOldOmega = omega;
      const wheelOldOmega = wheelOmega;
      const next = rk4Body(theta, omega, tau, dt, p);
      theta = next.theta;
      omega = next.omega;

      const wheelAlpha = tau / p.jw;
      wheelOmega += wheelAlpha * dt;
      if (Math.abs(wheelOmega) > p.maxWheelRadS) {
        wheelOmega = Math.sign(wheelOmega) * p.maxWheelRadS;
        saturated = true;
      }
      wheelAngle += 0.5 * (wheelOldOmega + wheelOmega) * dt;

      const omegaMid = 0.5 * (bodyOldOmega + omega);
      const wheelMid = 0.5 * (wheelOldOmega + wheelOmega);
      if (Math.abs(tau) > 0) {
        qEffective += p.currentMa * dt;
        bodyMotorWork += (-tau * omegaMid) * dt;
        motorWork += tau * (wheelMid - omegaMid) * dt;
      }
      const fric = frictionTorque(omegaMid, p);
      lossWork += fric * omegaMid * dt;
      t += dt;

      if (!crossed && lastTheta * theta <= 0 && Math.abs(lastTheta - theta) > 1e-12 && t > 2 * dt) {
        crossed = true;
        triggerEnergy = rockEnergy(theta, omega, p);
        if (pulseEnabled && qCommand > 0) {
          pulseTriggered = true;
          pulseStart = t;
          const bodyDesiredSign = p.energyAction === "add" ? Math.sign(omega) : -Math.sign(omega);
          tauSign = -bodyDesiredSign || -1;
        } else {
          pulseTriggered = true;
          pulseFinished = true;
          pulseStart = t;
          pulseEnd = t;
          pulseEndEnergy = triggerEnergy;
        }
      }

      if (pulseEnabled && pulseTriggered && !pulseFinished && t >= pulseStart + pulseDuration) {
        pulseFinished = true;
        pulseEnd = t;
        pulseEndEnergy = rockEnergy(theta, omega, p);
      }

      const canLookForPeak = crossed && (pulseFinished || !pulseEnabled) && t > (Number.isFinite(pulseEnd) ? pulseEnd + 2 * dt : pulseStart + 2 * dt);
      if (!nextPeak && canLookForPeak && lastOmega * omega <= 0 && Math.abs(theta) > 0.2 * DEG && Math.abs(lastOmega - omega) > 1e-10) {
        nextPeak = { t, theta, amplitudeDeg: Math.abs(theta) * RAD2DEG, energy: rockEnergy(theta, omega, p) };
      }

      const rpm = Math.abs(rpmFromRadS(wheelOmega));
      if (rpm > maxWheelRpm) maxWheelRpm = rpm;

      if (Math.abs(theta) > p.thetaOuter + 0.02 * DEG) {
        invalid = true;
        if (step % sampleEvery !== 0) pushSample(tau);
        break;
      }

      if (step % sampleEvery === 0) pushSample(tau);
      lastTheta = theta;
      lastOmega = omega;
    }

    if (!Number.isFinite(pulseEndEnergy) && pulseTriggered) pulseEndEnergy = rockEnergy(theta, omega, p);

    return {
      samples, nextPeak, triggerEnergy, pulseEndEnergy, qEffective, bodyMotorWork, motorWork, lossWork,
      maxWheelRpm, saturated, invalid, pulseTriggered, pulseStart, pulseEnd, qCommand,
      status: invalid ? "outside_model" : (!crossed ? "no_zero_cross" : (!nextPeak ? "no_next_peak" : "ok"))
    };
  }

  function runPair(p, qOverride = null) {
    const pulse = simulate(p, true, qOverride);
    const baseline = simulate(p, false, 0);
    const deltaE = pulse.nextPeak && baseline.nextPeak ? pulse.nextPeak.energy - baseline.nextPeak.energy : NaN;
    const targetEnergy = potential(p.targetDeg * DEG, p);
    return { pulse, baseline, deltaE, targetEnergy };
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
    els.metricQeff.textContent = pair.pulse.qEffective.toFixed(3);
    els.metricWheel.textContent = pair.pulse.maxWheelRpm.toFixed(0);
    els.metricTargetErr.textContent = ppk ? (ppk.amplitudeDeg - activeParams.targetDeg).toFixed(3) : "—";
  }

  function prettyMode(mode) {
    if (mode === "double_inner_edge") return "両内側端 接地";
    if (mode === "single_inner_edge_pivot") return "内側端点 支点";
    if (mode === "circular_arc") return "円弧 転がり";
    return "モデル範囲外";
  }

  function bodyContactPoint(theta, p) {
    const mag = Math.abs(theta);
    if (mag < 1e-9) return { x: 0, z: 0 };
    if (mag < p.thetaInner) return { x: theta > 0 ? -p.innerX : p.innerX, z: 0 };
    return { x: -p.radius * Math.sin(theta), z: p.hC0 - p.radius * Math.cos(theta) };
  }

  // World pose of the body origin in a floor-fixed coordinate system.
  // At theta=0, the body origin is x=0 and the two inner edges touch the floor
  // at x=+-innerX. In the central gap region the supporting inner edge is a
  // fixed pivot. Once circular contact starts, no-slip rolling advances the
  // contact point along the floor by the arc length R * Delta theta.
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
    return {
      x: pose.x + c * x - s * z,
      z: pose.z + s * x + c * z
    };
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

    // Fixed world-origin marker: this does not move with the body.
    ctx.strokeStyle = "#556474";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(originX, groundY - 8);
    ctx.lineTo(originX, groundY + 8);
    ctx.stroke();

    const theta = sample.theta;
    function wp(x, z) {
      const q = transformBodyPoint(x, z, theta, p);
      return { x: sx(q.x), y: sy(q.z) };
    }

    function drawArcSegment(x0, x1, color, width) {
      ctx.beginPath();
      const n = 36;
      for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n;
        const z = p.hC0 - Math.sqrt(Math.max(0, p.radius * p.radius - x * x));
        const q = wp(x, z);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    drawArcSegment(-p.outerX, -p.innerX, "#aab8c7", 8);
    drawArcSegment(p.innerX, p.outerX, "#aab8c7", 8);

    const bodyPts = [wp(-0.022, 0.018), wp(0.022, 0.018), wp(0.024, 0.185), wp(-0.024, 0.185)];
    ctx.beginPath();
    bodyPts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
    ctx.closePath();
    ctx.fillStyle = "#344658";
    ctx.fill();
    ctx.strokeStyle = "#7690aa";
    ctx.lineWidth = 2;
    ctx.stroke();

    const crossL = wp(-0.070, 0.065), crossR = wp(0.070, 0.065);
    ctx.beginPath(); ctx.moveTo(crossL.x, crossL.y); ctx.lineTo(crossR.x, crossR.y);
    ctx.strokeStyle = "#5f7892"; ctx.lineWidth = 9; ctx.lineCap = "round"; ctx.stroke();

    const wheelC = wp(0, 0.150);
    const wheelR = 0.032 * scale;
    ctx.beginPath(); ctx.arc(wheelC.x, wheelC.y, wheelR, 0, TWO_PI);
    ctx.fillStyle = "#19232e"; ctx.fill();
    ctx.strokeStyle = "#68a8ff"; ctx.lineWidth = 4; ctx.stroke();
    for (let k = 0; k < 4; k++) {
      const a = sample.wheelAngle + k * Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(wheelC.x, wheelC.y);
      ctx.lineTo(wheelC.x + Math.cos(a) * wheelR * 0.85, wheelC.y - Math.sin(a) * wheelR * 0.85);
      ctx.strokeStyle = "#4f80b5"; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(wheelC.x, wheelC.y, 5, 0, TWO_PI); ctx.fillStyle = "#d7e8fb"; ctx.fill();

    const cg = wp(0, p.h);
    ctx.beginPath(); ctx.arc(cg.x, cg.y, 7, 0, TWO_PI); ctx.fillStyle = "#ff6b6b"; ctx.fill();
    ctx.fillStyle = "#ff9b9b"; ctx.font = "12px system-ui"; ctx.fillText("CG", cg.x + 10, cg.y - 8);

    // Show the actual support/contact location on the fixed floor.
    ctx.fillStyle = "#ffd166";
    if (Math.abs(theta) < 1e-9) {
      const qL = wp(-p.innerX, 0);
      const qR = wp(p.innerX, 0);
      ctx.beginPath(); ctx.arc(qL.x, qL.y, 5, 0, TWO_PI); ctx.fill();
      ctx.beginPath(); ctx.arc(qR.x, qR.y, 5, 0, TWO_PI); ctx.fill();
    } else {
      const cpt = bodyContactPoint(theta, p);
      const cq = wp(cpt.x, cpt.z);
      ctx.beginPath(); ctx.arc(cq.x, cq.y, 6, 0, TWO_PI); ctx.fill();
    }

    ctx.fillStyle = "#dce7f2";
    ctx.font = "600 15px system-ui";
    ctx.fillText(`${(theta * RAD2DEG).toFixed(2)}°`, 20, 28);
    ctx.fillStyle = "#91a0b1";
    ctx.font = "12px system-ui";
    ctx.fillText(prettyMode(sample.mode), 20, 48);
    if (Math.abs(sample.tau) > 0) {
      ctx.fillStyle = "#7ee0b8";
      ctx.fillText(`PULSE  Q=${sample.qEffective.toFixed(3)} mA·s`, 20, 70);
    }
  }

  function chartAxes(ctx, w, h, xMin, xMax, yMin, yMax, xLabel, yLabel) {
    const pad = { l: 52, r: 16, t: 18, b: 40 };
    const X = x => pad.l + (x - xMin) / (xMax - xMin || 1) * (w - pad.l - pad.r);
    const Y = y => h - pad.b - (y - yMin) / (yMax - yMin || 1) * (h - pad.t - pad.b);
    ctx.strokeStyle = "#26313e"; ctx.lineWidth = 1;
    ctx.fillStyle = "#8292a3"; ctx.font = "11px system-ui";
    for (let i = 0; i <= 5; i++) {
      const xv = xMin + (xMax - xMin) * i / 5;
      const px = X(xv);
      ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, h - pad.b); ctx.stroke();
      ctx.fillText(xv.toFixed(xMax <= 5 ? 2 : 1), px - 10, h - 16);
    }
    for (let i = 0; i <= 4; i++) {
      const yv = yMin + (yMax - yMin) * i / 4;
      const py = Y(yv);
      ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(w - pad.r, py); ctx.stroke();
      ctx.fillText(yv.toFixed(Math.abs(yMax - yMin) < 1 ? 3 : 1), 5, py + 4);
    }
    ctx.fillStyle = "#a9b5c2";
    ctx.fillText(xLabel, w - 58, h - 16);
    ctx.save(); ctx.translate(13, 76); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore();
    return { X, Y };
  }

  function drawTimeChart(pair) {
    const canvas = els.timeChart, ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#090e14"; ctx.fillRect(0, 0, w, h);
    const all = pair.pulse.samples.concat(pair.baseline.samples);
    const xMax = Math.max(...all.map(s => s.t), 1);
    const vals = all.map(s => s.theta * RAD2DEG);
    const absMax = Math.max(1, ...vals.map(Math.abs));
    const { X, Y } = chartAxes(ctx, w, h, 0, xMax, -absMax * 1.08, absMax * 1.08, "t [s]", "θ [deg]");

    function line(samples, color, dash) {
      ctx.beginPath();
      samples.forEach((s, i) => {
        const x = X(s.t), y = Y(s.theta * RAD2DEG);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    }
    line(pair.baseline.samples, "#71849a", [6, 5]);
    line(pair.pulse.samples, "#68a8ff", []);
    if (Number.isFinite(pair.pulse.pulseStart)) {
      const x = X(pair.pulse.pulseStart);
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, h - 40); ctx.strokeStyle = "#7ee0b8"; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function drawSweep(data, options) {
    const canvas = els.sweepChart, ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#090e14"; ctx.fillRect(0, 0, w, h);
    if (!data || data.length === 0) return;
    const xs = data.map(d => d.x), ys = data.map(d => d.y).filter(Number.isFinite);
    if (!ys.length) return;
    let xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xp = Math.max(0.05 * (xMax - xMin || 1), 0.05);
    const yp = Math.max(0.12 * (yMax - yMin || 1), 0.01);
    xMin -= xp; xMax += xp; yMin -= yp; yMax += yp;
    const { X, Y } = chartAxes(ctx, w, h, xMin, xMax, yMin, yMax, options.xLabel, options.yLabel);
    ctx.beginPath();
    let started = false;
    data.forEach(d => {
      if (!Number.isFinite(d.y)) return;
      if (!started) { ctx.moveTo(X(d.x), Y(d.y)); started = true; } else ctx.lineTo(X(d.x), Y(d.y));
    });
    ctx.strokeStyle = "#7ee0b8"; ctx.lineWidth = 2; ctx.stroke();
    data.forEach(d => {
      if (!Number.isFinite(d.y)) return;
      ctx.beginPath(); ctx.arc(X(d.x), Y(d.y), 4.5, 0, TWO_PI); ctx.fillStyle = d.invalid ? "#ff7474" : "#7ee0b8"; ctx.fill();
    });
  }

  function linearFit(points) {
    const v = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (v.length < 2) return null;
    const mx = v.reduce((s,p) => s+p.x,0)/v.length;
    const my = v.reduce((s,p) => s+p.y,0)/v.length;
    let sxx=0, sxy=0, sst=0, sse=0;
    v.forEach(p => { sxx += (p.x-mx)**2; sxy += (p.x-mx)*(p.y-my); });
    const slope = sxx ? sxy/sxx : 0;
    const intercept = my - slope*mx;
    v.forEach(p => { const yhat=intercept+slope*p.x; sst+=(p.y-my)**2; sse+=(p.y-yhat)**2; });
    const r2 = sst > 0 ? 1-sse/sst : 1;
    return { slope, intercept, r2 };
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
    drawTimeChart(activePair);
    const s = activePair.pulse.samples[0];
    drawMotion(s, p);
    updateLive(s);
  }

  function runQSweep() {
    const p = readParams();
    activeParams = p;
    const maxQ = Math.max(2.0, p.qMas * 1.8);
    const n = 13;
    const data = [];
    for (let i = 0; i < n; i++) {
      const q = maxQ * i / (n - 1);
      const pair = runPair(p, q);
      data.push({ x: q, y: Number.isFinite(pair.deltaE) ? pair.deltaE * 1000 : NaN, invalid: pair.pulse.invalid || pair.pulse.saturated });
    }
    drawSweep(data, { xLabel: "Q [mA·s]", yLabel: "ΔEobs [mJ]" });
    els.sweepTitle.textContent = "Q sweep";
    els.sweepSubtitle.textContent = `初期振幅 ${p.initialDeg.toFixed(1)}°、最初のゼロクロス状態を固定。`;
    const fit = linearFit(data);
    if (fit) {
      els.sweepSummary.innerHTML = `線形近似: ΔEobs = <strong>${fit.slope.toFixed(4)}</strong> Q + ${fit.intercept.toFixed(4)} mJ　 R²=<strong>${fit.r2.toFixed(4)}</strong><br>R²が高くても、この状態での局所関係を示すだけです。状態独立性は初期振幅 sweep で確認します。`;
    }
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
      const cross = pair.pulse.samples.reduce((best, s) => {
        if (!Number.isFinite(pair.pulse.pulseStart)) return best;
        return Math.abs(s.t - pair.pulse.pulseStart) < Math.abs(best.t - pair.pulse.pulseStart) ? s : best;
      }, pair.pulse.samples[0]);
      rows.push({ a, de, crossRate: Math.abs(cross.omega) * RAD2DEG });
    });
    drawSweep(data, { xLabel: "A₀ [deg]", yLabel: "ΔEobs [mJ]" });
    els.sweepTitle.textContent = "初期振幅 sweep";
    els.sweepSubtitle.textContent = `Q=${p.qMas.toFixed(3)} mA·s を同じ方法で最初のゼロクロスへ投入。`;
    const vals = rows.map(r => r.de).filter(Number.isFinite);
    const min = vals.length ? Math.min(...vals) : NaN;
    const max = vals.length ? Math.max(...vals) : NaN;
    const mean = vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : NaN;
    const spread = Number.isFinite(mean) && Math.abs(mean)>1e-12 ? (max-min)/Math.abs(mean)*100 : NaN;
    const rowText = rows.map(r => `${r.a}°: ${Number.isFinite(r.de)?r.de.toFixed(4):"—"} mJ @ ${r.crossRate.toFixed(1)}°/s`).join("　/　");
    els.sweepSummary.innerHTML = `${rowText}<br>ΔEobs の範囲: <strong>${Number.isFinite(min)?min.toFixed(4):"—"}〜${Number.isFinite(max)?max.toFixed(4):"—"} mJ</strong>${Number.isFinite(spread)?`（平均に対する幅 ${spread.toFixed(1)}%）`:""}。大きく変わるなら Q 単独写像では不足です。`;
  }

  function updateLive(s) {
    if (!s) return;
    els.liveT.textContent = s.t.toFixed(3);
    els.liveTheta.textContent = (s.theta * RAD2DEG).toFixed(2);
    els.liveOmega.textContent = (s.omega * RAD2DEG).toFixed(1);
    els.liveRpm.textContent = rpmFromRadS(s.wheelOmega).toFixed(0);
    els.liveMode.textContent = prettyMode(s.mode);
  }

  function sampleAtTime(samples, t) {
    if (!samples.length) return null;
    if (t <= samples[0].t) return samples[0];
    if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
    let lo=0, hi=samples.length-1;
    while (hi-lo>1) {
      const mid=(lo+hi)>>1;
      if (samples[mid].t < t) lo=mid; else hi=mid;
    }
    return Math.abs(samples[lo].t-t) < Math.abs(samples[hi].t-t) ? samples[lo] : samples[hi];
  }

  function animate(ts) {
    if (!activePair || !activeParams) {
      requestAnimationFrame(animate);
      return;
    }
    if (!lastFrameTs) lastFrameTs = ts;
    const dtReal = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;
    if (playing) {
      const speed = parseFloat(els.speedSelect.value) || 1;
      playbackTime += dtReal * speed;
      const endT = activePair.pulse.samples[activePair.pulse.samples.length - 1].t;
      if (playbackTime >= endT) {
        playbackTime = endT;
        playing = false;
        els.playBtn.textContent = "▶ 再生";
      }
      const s = sampleAtTime(activePair.pulse.samples, playbackTime);
      drawMotion(s, activeParams);
      updateLive(s);
    }
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
    }
  });

  runMain();
  runQSweep();
  requestAnimationFrame(animate);
})();