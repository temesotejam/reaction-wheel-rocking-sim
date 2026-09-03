(() => {
  "use strict";

  const G = 9.80665;
  const DEG = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const TWO_PI = 2 * Math.PI;

  const I_SAT_MA = 329.547;
  const P_SAT = 3.86;
  const TAU_RISE_MIN_MS = 31.4;
  const TAU_RISE_MAX_MS = 72.8;
  const U_TAU_MA = 372.0;
  const Q_TAU = 4.35;

  const els = {};
  [
    "statusBadge","motionCanvas","historyCanvas","playBtn","restartBtn","speedSelect","runBtn",
    "initialPeakDeg","targetDeg","currentMa","peakDeadbandDeg","simSeconds",
    "gPlus","gMinus","qModelMinMas","qModelMaxMas","kiMasPerDeg","iLimitMas","predLossPlus","predLossMinus",
    "tauFallMs","kt","jw","maxRpm","massKg","ieff","viscous","coulomb","dtMs","validationMsg",
    "liveT","liveControl","liveTheta","liveOmega","livePeak","liveNextSide","liveAFree","liveARef","liveDeltaE",
    "liveQff","liveIPlus","liveIMinus","liveQcmd","liveQactual","liveICmd","liveIActual","liveRpm","liveWheelAngle",
    "liveModelStatus","liveWheelHeadroom","liveMode","liveDecision","eventBody",
    "flowPeak","flowFree","flowGap","flowQ","flowCmd","flowCurrent","flowWheel","flowActualPeak"
  ].forEach(id => { els[id] = document.getElementById(id); });

  let activeRun = null;
  let activeParams = null;
  let playing = false;
  let playbackTime = 0;
  let lastFrameTs = 0;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const finiteOr = (v, fallback) => Number.isFinite(v) ? v : fallback;
  const rpmFromRadS = w => w * 60 / TWO_PI;
  const sideText = s => s > 0 ? "+" : (s < 0 ? "−" : "—");

  function currentGoalMa(commandMa) {
    const u = Math.abs(commandMa);
    if (u < 1e-12) return 0;
    return u / Math.pow(1 + Math.pow(u / I_SAT_MA, P_SAT), 1 / P_SAT);
  }

  function tauRiseS(commandMa) {
    const u = Math.abs(commandMa);
    const tauMs = TAU_RISE_MIN_MS + (TAU_RISE_MAX_MS - TAU_RISE_MIN_MS) /
      (1 + Math.pow(u / U_TAU_MA, Q_TAU));
    return tauMs / 1000;
  }

  function signedQTotalForWidth(i0Ma, commandMa, widthS, tauFallS) {
    if (widthS <= 0 || Math.abs(commandMa) < 1e-12) return i0Ma * tauFallS;
    const sign = Math.sign(commandMa);
    const goal = sign * currentGoalMa(commandMa);
    const tau = tauRiseS(commandMa);
    const e = Math.exp(-widthS / tau);
    const onIntegral = goal * widthS + (i0Ma - goal) * tau * (1 - e);
    const iEnd = goal + (i0Ma - goal) * e;
    return onIntegral + iEnd * tauFallS;
  }

  function solvePulseWidthForSignedQ(targetSignedQMas, i0Ma, commandMa, tauFallS) {
    if (Math.abs(targetSignedQMas) < 1e-9 || Math.abs(commandMa) < 1e-12) return 0;
    const targetSign = Math.sign(targetSignedQMas);
    const targetMag = Math.abs(targetSignedQMas);
    const progress = w => targetSign * signedQTotalForWidth(i0Ma, commandMa, w, tauFallS);
    let lo = 0, hi = 0.001, guard = 0;
    while (progress(hi) < targetMag && guard < 80) { hi *= 2; guard++; }
    if (!Number.isFinite(hi) || progress(hi) < targetMag) return NaN;
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi);
      if (progress(mid) < targetMag) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  function readParams() {
    const p = {
      initialPeakDeg: Math.max(0.01, finiteOr(parseFloat(els.initialPeakDeg.value), 0.8)),
      targetDeg: Math.max(0.01, finiteOr(parseFloat(els.targetDeg.value), 2.0)),
      currentMa: Math.max(1, finiteOr(parseFloat(els.currentMa.value), 300)),
      peakDeadbandDeg: Math.max(0, finiteOr(parseFloat(els.peakDeadbandDeg.value), 0.03)),
      simSeconds: clamp(finiteOr(parseFloat(els.simSeconds.value), 12), 2, 30),
      gPlus: Math.max(1e-6, finiteOr(parseFloat(els.gPlus.value), 0.290316)),
      gMinus: Math.max(1e-6, finiteOr(parseFloat(els.gMinus.value), 0.254547)),
      qModelMinMas: Math.max(0, finiteOr(parseFloat(els.qModelMinMas.value), 0.454)),
      qModelMaxMas: Math.max(0.001, finiteOr(parseFloat(els.qModelMaxMas.value), 1.197)),
      kiMasPerDeg: Math.max(0, finiteOr(parseFloat(els.kiMasPerDeg.value), 0.08)),
      iLimitMas: Math.max(0, finiteOr(parseFloat(els.iLimitMas.value), 0.45)),
      predLossPlus: Math.max(0.01, finiteOr(parseFloat(els.predLossPlus.value), 1.0)),
      predLossMinus: Math.max(0.01, finiteOr(parseFloat(els.predLossMinus.value), 1.0)),
      tauFall: Math.max(0.001, finiteOr(parseFloat(els.tauFallMs.value), 73) / 1000),
      kt: Math.max(1e-7, finiteOr(parseFloat(els.kt.value), 0.036)),
      jw: Math.max(1e-9, finiteOr(parseFloat(els.jw.value), 0.000021)),
      maxRpm: Math.max(100, finiteOr(parseFloat(els.maxRpm.value), 1050)),
      mass: Math.max(0.001, finiteOr(parseFloat(els.massKg.value), 0.1997)),
      ieff: Math.max(1e-8, finiteOr(parseFloat(els.ieff.value), 0.00090)),
      viscous: Math.max(0, finiteOr(parseFloat(els.viscous.value), 0.00050)),
      coulomb: Math.max(0, finiteOr(parseFloat(els.coulomb.value), 0.0)),
      dt: clamp(finiteOr(parseFloat(els.dtMs.value), 0.2), 0.02, 2) / 1000,
      radius: 0.150,
      innerX: 0.005,
      outerX: 0.045,
      h: 0.120,
      omegaFrictionEps: 0.03,
      currentTailThresholdMa: 1.0
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
    const limit = p.thetaOuter * RAD2DEG;
    if (p.initialPeakDeg >= limit) msgs.push(`最初のピークは ${limit.toFixed(2)}° 未満にしてください。`);
    if (p.targetDeg > limit) msgs.push(`目標ピークは ${limit.toFixed(2)}° 以下にしてください。`);
    if (p.dt > 0.001) msgs.push("短い電流入力を見るには dt ≤ 1 ms を推奨します。");
    if (p.targetDeg >= 16.5) msgs.push("目標が足裏円弧外端に近いため、接触モデル限界に注意してください。");
    return msgs;
  }

  function contactMode(theta, p) {
    const a = Math.abs(theta);
    if (a < 1e-9) return "double_inner_edge";
    if (a < p.thetaInner) return "single_inner_edge_pivot";
    if (a <= p.thetaOuter) return "circular_arc";
    return "outside_model";
  }

  function prettyMode(mode) {
    if (mode === "double_inner_edge") return "両内側端";
    if (mode === "single_inner_edge_pivot") return "内側端支点";
    if (mode === "circular_arc") return "円弧転がり";
    return "モデル外";
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

  // Effective roll inertia identified from passive free-decay periods.
  // This is deliberately an empirical Ieff, not CAD/CG inertia. The previous
  // rigid-body Icg + translation expression could not reproduce the measured
  // ~0.71--0.77 s periods with a physically positive Icg.
  function effectiveInertia(theta, p) { return p.ieff; }
  function inertiaDerivative(theta, p) { return 0; }

  function potential(theta, p) { return p.mass * G * deltaHeight(theta, p); }
  function rockEnergy(theta, omega, p) { return 0.5 * effectiveInertia(theta, p) * omega * omega + potential(theta, p); }

  function frictionTorque(omega, p, scale = 1) {
    return scale * (p.viscous * omega + p.coulomb * Math.tanh(omega / p.omegaFrictionEps));
  }

  function acceleration(theta, omega, tauMotor, p, lossScale = 1) {
    const j = effectiveInertia(theta, p);
    const jp = inertiaDerivative(theta, p);
    const du = p.mass * G * dHeightDTheta(theta, omega, p);
    return (-0.5 * jp * omega * omega - du - frictionTorque(omega, p, lossScale) - tauMotor) / j;
  }

  function rk4Body(theta, omega, tau, dt, p, lossScale = 1) {
    const a1 = acceleration(theta, omega, tau, p, lossScale);
    const th2 = theta + 0.5 * dt * omega, om2 = omega + 0.5 * dt * a1;
    const a2 = acceleration(th2, om2, tau, p, lossScale);
    const th3 = theta + 0.5 * dt * om2, om3 = omega + 0.5 * dt * a2;
    const a3 = acceleration(th3, om3, tau, p, lossScale);
    const th4 = theta + dt * om3, om4 = omega + dt * a3;
    const a4 = acceleration(th4, om4, tau, p, lossScale);
    return {
      theta: theta + dt * (omega + 2 * om2 + 2 * om3 + om4) / 6,
      omega: omega + dt * (a1 + 2 * a2 + 2 * a3 + a4) / 6
    };
  }

  const freeCache = new Map();
  function freePredict(Adeg, nextSide, p) {
    const scale = nextSide > 0 ? p.predLossPlus : p.predLossMinus;
    const key = `${Adeg.toFixed(3)}|${nextSide}|${scale.toFixed(3)}|${p.viscous}|${p.coulomb}|${p.dt}`;
    if (freeCache.has(key)) return freeCache.get(key);
    const dt = Math.max(p.dt, 0.0004);
    let theta = -nextSide * Adeg * DEG;
    let omega = 0;
    let lastTheta = theta, lastOmega = omega;
    let crossed = false;
    let result = Math.max(0, Adeg * 0.95);
    for (let k = 0; k < Math.ceil(3 / dt); k++) {
      const n = rk4Body(theta, omega, 0, dt, p, scale);
      theta = n.theta; omega = n.omega;
      if (!crossed && lastTheta * theta <= 0 && Math.abs(lastTheta - theta) > 1e-12) crossed = true;
      if (crossed && lastOmega * omega <= 0 && Math.sign(theta) === nextSide && Math.abs(theta) > 0.01 * DEG) {
        result = Math.abs(theta) * RAD2DEG;
        break;
      }
      lastTheta = theta; lastOmega = omega;
    }
    freeCache.set(key, result);
    return result;
  }

  function gainForSide(side, p) { return side > 0 ? p.gPlus : p.gMinus; }
  function iForSide(side, state) { return side > 0 ? state.iPlus : state.iMinus; }

  function qFeedForward(Afree, side, p) {
    const eFree = potential(side * Afree * DEG, p);
    const eRef = potential(side * p.targetDeg * DEG, p);
    if (Afree >= p.targetDeg - p.peakDeadbandDeg) {
      return { qFF: 0, eFree, eRef, deltaE: 0 };
    }
    const deltaE = eRef - eFree;
    const g = gainForSide(side, p);
    // U_s is monotonic in the controlled region, so the energy-matching solution
    // is equivalent to Afree + g_s Q = Aref. No artificial upper Q cap is applied.
    const qFF = Math.max(0, (p.targetDeg - Afree) / g);
    return { qFF, eFree, eRef, deltaE };
  }

  function wheelQHeadroomMas(wheelOmega, commandMa, p) {
    if (Math.abs(commandMa) < 1e-12) return Infinity;
    const dir = Math.sign(commandMa);
    const deltaOmega = p.maxWheelRadS - dir * wheelOmega;
    return Math.max(0, p.jw * deltaOmega / p.kt * 1000);
  }

  function updateIntegralAfterPeak(event, actualPeakDeg, state, p) {
    if (!event) return;
    const err = p.targetDeg - actualPeakDeg;
    const side = event.nextSide;
    const oldI = side > 0 ? state.iPlus : state.iMinus;
    let nextI = oldI;
    const atLow = event.qCmd <= 1e-8;
    // Only the no-braking floor saturates Qcmd. There is no artificial upper Q cap.
    if (!(atLow && err < 0)) {
      nextI = clamp(oldI + p.kiMasPerDeg * err, -p.iLimitMas, p.iLimitMas);
    }
    if (side > 0) state.iPlus = nextI; else state.iMinus = nextI;
    event.actualPeakDeg = actualPeakDeg;
    event.peakErrorDeg = err;
    event.iAfter = nextI;
  }

  function bodyContactPoint(theta, p) {
    const mag = Math.abs(theta);
    if (mag < 1e-9) return { x: 0, z: 0 };
    if (mag < p.thetaInner) return { x: theta > 0 ? -p.innerX : p.innerX, z: 0 };
    return { x: -p.radius * Math.sin(theta), z: p.hC0 - p.radius * Math.cos(theta) };
  }

  function bodyPose(theta, p) {
    const mag = Math.abs(theta);
    if (mag < 1e-9) return { x:0,z:0,contactX:0 };
    const side = Math.sign(theta), c = Math.cos(theta), s = Math.sin(theta);
    if (mag < p.thetaInner) {
      const pivotBodyX = side > 0 ? -p.innerX : p.innerX;
      return { x:pivotBodyX-c*pivotBodyX, z:-s*pivotBodyX, contactX:pivotBodyX };
    }
    const contactWorldX = -side * (p.innerX + p.radius * (mag - p.thetaInner));
    return { x:contactWorldX+p.hC0*s, z:p.radius-p.hC0*c, contactX:contactWorldX };
  }

  function transformBodyPoint(x, z, theta, p) {
    const pose = bodyPose(theta,p), c=Math.cos(theta), s=Math.sin(theta);
    return { x:pose.x+c*x-s*z, z:pose.z+s*x+c*z };
  }

  function simulatePeakController(p) {
    freeCache.clear();
    const dt = p.dt;
    const maxSteps = Math.ceil(p.simSeconds / dt);
    const sampleEvery = Math.max(1, Math.round(0.002 / dt));
    let t = 0, theta = p.initialPeakDeg * DEG, omega = 0;
    let lastTheta = theta, lastOmega = omega;
    let currentActualMa = 0, currentCmdMa = 0;
    let wheelOmega = 0, wheelAngle = 0;
    let activePulse = null;
    let qEventActual = 0;
    let zcCount = 0, peakCount = 1;
    let lastPeakDeg = p.initialPeakDeg;
    let lastPeakSide = +1;
    let currentDecision = null;
    let pendingEvent = null;
    let saturated = false, invalid = false, modelExtrapolated = false;
    const state = { iPlus: 0, iMinus: 0 };
    const events = [], peaks = [{ index:1, t:0, side:+1, ampDeg:lastPeakDeg }], samples = [];

    function pushSample(tauMotor) {
      const s = {
        t, theta, omega, currentActualMa, currentCmdMa, tauMotor,
        wheelOmega, wheelAngle, qEventActual,
        lastPeakDeg, lastPeakSide, peakCount, zcCount,
        iPlus: state.iPlus, iMinus: state.iMinus,
        controlState: "COAST", nextSide: 0, Afree: NaN, deltaE: 0, qFF: 0, qCmd: 0,
        modelSupported: true, wheelQHeadroom: Infinity,
        decisionText: "START_KICK後の最初の実ピークを現在状態として使用。以後は通常の目標追従閉ループです。", mode: contactMode(theta,p)
      };
      if (currentDecision) {
        Object.assign(s, {
          controlState: Math.abs(currentCmdMa)>1e-6 ? "INPUT" : (Math.abs(currentActualMa)>p.currentTailThresholdMa ? "CURRENT TAIL" : "COAST"),
          nextSide: currentDecision.nextSide, Afree: currentDecision.Afree, deltaE: currentDecision.deltaE,
          qFF: currentDecision.qFF, qCmd: currentDecision.qCmd,
          modelSupported: currentDecision.modelSupported, wheelQHeadroom: currentDecision.wheelQHeadroom,
          decisionText: currentDecision.text
        });
      }
      samples.push(s);
    }

    pushSample(0);

    for (let step = 0; step < maxSteps; step++) {
      currentCmdMa = activePulse && t < activePulse.end ? activePulse.commandMa : 0;
      const iOld = currentActualMa;
      if (Math.abs(currentCmdMa) > 1e-9) {
        const goal = Math.sign(currentCmdMa) * currentGoalMa(currentCmdMa);
        const a = 1 - Math.exp(-dt / tauRiseS(currentCmdMa));
        currentActualMa += a * (goal - currentActualMa);
      } else {
        currentActualMa *= Math.exp(-dt / p.tauFall);
      }
      if (Math.abs(currentActualMa) < 1e-8) currentActualMa = 0;
      const iMid = 0.5 * (iOld + currentActualMa);
      if (zcCount > 0) qEventActual += Math.abs(iMid) * dt;

      let tauMotor = p.kt * (iMid / 1000);
      const wouldIncreaseWheel = wheelOmega === 0 || Math.sign(tauMotor) === Math.sign(wheelOmega);
      if (Math.abs(wheelOmega) >= p.maxWheelRadS && wouldIncreaseWheel) {
        tauMotor = 0;
        saturated = true;
        activePulse = null;
        if (pendingEvent) pendingEvent.actuatorLimited = true;
      }

      const oldWheelOmega = wheelOmega;
      const n = rk4Body(theta, omega, tauMotor, dt, p, 1);
      theta = n.theta; omega = n.omega;
      wheelOmega += (tauMotor / p.jw) * dt;
      if (Math.abs(wheelOmega) > p.maxWheelRadS) {
        wheelOmega = Math.sign(wheelOmega) * p.maxWheelRadS;
        saturated = true;
        activePulse = null;
        if (pendingEvent) pendingEvent.actuatorLimited = true;
      }
      wheelAngle += 0.5 * (oldWheelOmega + wheelOmega) * dt;
      t += dt;

      if (lastOmega * omega <= 0 && Math.abs(theta) > 0.03 * DEG && Math.sign(theta) !== 0 && t > 0.02) {
        const side = Math.sign(theta);
        const amp = Math.abs(theta) * RAD2DEG;
        peakCount++;
        lastPeakDeg = amp;
        lastPeakSide = side;
        peaks.push({ index:peakCount, t, side, ampDeg:amp });
        if (pendingEvent && pendingEvent.nextSide === side && pendingEvent.actualPeakDeg == null) {
          updateIntegralAfterPeak(pendingEvent, amp, state, p);
          pendingEvent = null;
        }
        currentDecision = null;
      }

      if (lastTheta * theta <= 0 && Math.abs(lastTheta - theta) > 1e-12 && t > 0.02) {
        zcCount++;
        qEventActual = 0;
        const nextSide = Math.sign(omega) || -lastPeakSide;
        const Afree = freePredict(lastPeakDeg, nextSide, p);
        const ff = qFeedForward(Afree, nextSide, p);
        const iSide = iForSide(nextSide, state);
        let qCmd = 0;
        if (Afree < p.targetDeg - p.peakDeadbandDeg) qCmd = Math.max(0, ff.qFF + iSide);
        const action = qCmd > 0 ? "TARGET_TRACK_INPUT" : "TARGET_TRACK_HOLD";
        const commandMa = qCmd > 0 ? -Math.sign(omega || nextSide) * p.currentMa : 0;
        const signedQ = Math.sign(commandMa) * qCmd;
        const pulseWidth = qCmd > 0 ? solvePulseWidthForSignedQ(signedQ, currentActualMa, commandMa, p.tauFall) : 0;
        const modelSupported = qCmd <= 1e-9 || (qCmd >= p.qModelMinMas - 1e-9 && qCmd <= p.qModelMaxMas + 1e-9);
        if (!modelSupported) modelExtrapolated = true;
        const wheelQHeadroom = wheelQHeadroomMas(wheelOmega, commandMa, p);
        const wheelFeasible = !Number.isFinite(wheelQHeadroom) || qCmd <= wheelQHeadroom + 1e-9;
        const event = {
          index: zcCount, t, nextSide, Ak:lastPeakDeg, Afree, deltaEMj:ff.deltaE*1000,
          qFF:ff.qFF, iUsed:iSide, qCmd, pulseWidthMs:pulseWidth*1000,
          action,
          modelSupported, wheelQHeadroom, wheelFeasible, actuatorLimited:false,
          actualPeakDeg:null, peakErrorDeg:null, iAfter:null
        };
        events.push(event);
        pendingEvent = event;
        currentDecision = {
          ...event,
          text: qCmd > 0
            ? `ZC #${zcCount}: Aₖ=${lastPeakDeg.toFixed(3)}° → Afree=${Afree.toFixed(3)}° → 目標${p.targetDeg.toFixed(3)}°へ Qff=${ff.qFF.toFixed(3)} + I${sideText(nextSide)}=${iSide.toFixed(3)} → Qcmd=${qCmd.toFixed(3)} mA·s${modelSupported ? "" : " [gモデル外挿]"}${wheelFeasible ? "" : " [RW回転数能力超過]"}`
            : `ZC #${zcCount}: Afree=${Afree.toFixed(3)}°。目標${p.targetDeg.toFixed(3)}°以上/不感帯内なのでQ=0（ブレーキなし）`
        };
        if (qCmd > 0 && pulseWidth > 0) {
          activePulse = { start:t, end:t+pulseWidth, commandMa, qCmd };
        } else activePulse = null;
      }

      if (activePulse && t >= activePulse.end) activePulse = null;
      if (Math.abs(theta) > p.thetaOuter + 0.03 * DEG) { invalid = true; pushSample(tauMotor); break; }
      if (step % sampleEvery === 0) pushSample(tauMotor);
      lastTheta = theta; lastOmega = omega;
    }

    return { samples, events, peaks, saturated, invalid, modelExtrapolated };
  }

  function drawRotationArrow(ctx,cx,cy,r,dir,color,width=3) {
    if(!dir)return;
    const start=dir>0?-0.55:0.55, span=dir*1.85, n=28;
    ctx.save();ctx.beginPath();
    for(let i=0;i<=n;i++){const a=start+span*i/n,x=cx+r*Math.cos(a),y=cy-r*Math.sin(a);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap="round";ctx.stroke();
    const a=start+span,tipX=cx+r*Math.cos(a),tipY=cy-r*Math.sin(a),tx=-Math.sin(a)*dir,ty=-Math.cos(a)*dir,nx=-ty,ny=tx;
    ctx.beginPath();ctx.moveTo(tipX,tipY);ctx.lineTo(tipX-tx*10+nx*5,tipY-ty*10+ny*5);ctx.lineTo(tipX-tx*10-nx*5,tipY-ty*10-ny*5);ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.restore();
  }

  function drawMotion(s,p) {
    const canvas=els.motionCanvas,ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);ctx.fillStyle="#090e14";ctx.fillRect(0,0,w,h);
    const groundY=h-62,originX=w*.5,scale=Math.min(w/.54,h/.31),sx=x=>originX+x*scale,sy=z=>groundY-z*scale;
    ctx.strokeStyle="#3a4654";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(25,groundY);ctx.lineTo(w-25,groundY);ctx.stroke();
    ctx.strokeStyle="#202a35";ctx.lineWidth=1;for(let x=35;x<w-25;x+=40){ctx.beginPath();ctx.moveTo(x,groundY+1);ctx.lineTo(x-13,groundY+12);ctx.stroke();}
    const wp=(x,z)=>{const q=transformBodyPoint(x,z,s.theta,p);return{x:sx(q.x),y:sy(q.z)};};
    function arcSeg(x0,x1){ctx.beginPath();for(let i=0;i<=36;i++){const x=x0+(x1-x0)*i/36,z=p.hC0-Math.sqrt(Math.max(0,p.radius*p.radius-x*x)),q=wp(x,z);if(i===0)ctx.moveTo(q.x,q.y);else ctx.lineTo(q.x,q.y);}ctx.strokeStyle="#aab8c7";ctx.lineWidth=8;ctx.lineCap="round";ctx.stroke();}
    arcSeg(-p.outerX,-p.innerX);arcSeg(p.innerX,p.outerX);
    const body=[wp(-.022,.018),wp(.022,.018),wp(.024,.185),wp(-.024,.185)];ctx.beginPath();body.forEach((q,i)=>i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y));ctx.closePath();ctx.fillStyle="#344658";ctx.fill();ctx.strokeStyle="#7690aa";ctx.lineWidth=2;ctx.stroke();
    const l=wp(-.070,.065),r=wp(.070,.065);ctx.beginPath();ctx.moveTo(l.x,l.y);ctx.lineTo(r.x,r.y);ctx.strokeStyle="#5f7892";ctx.lineWidth=9;ctx.stroke();
    const wc=wp(0,.150),wr=.032*scale,cmdOn=Math.abs(s.currentCmdMa)>1e-6;ctx.beginPath();ctx.arc(wc.x,wc.y,wr,0,TWO_PI);ctx.fillStyle="#19232e";ctx.fill();ctx.strokeStyle=cmdOn?"#7ee0b8":"#68a8ff";ctx.lineWidth=4;ctx.stroke();
    for(let k=0;k<6;k++){const a=s.wheelAngle+k*TWO_PI/6;ctx.beginPath();ctx.moveTo(wc.x,wc.y);ctx.lineTo(wc.x+Math.cos(a)*wr*.85,wc.y-Math.sin(a)*wr*.85);ctx.strokeStyle=cmdOn?"#9debc9":"#4f80b5";ctx.lineWidth=2;ctx.stroke();}
    if(Math.abs(s.wheelOmega)>1e-3)drawRotationArrow(ctx,wc.x,wc.y,wr+14,Math.sign(s.wheelOmega),s.wheelOmega>0?"#7ee0b8":"#ffb86b");
    const cg=wp(0,p.h);ctx.beginPath();ctx.arc(cg.x,cg.y,7,0,TWO_PI);ctx.fillStyle="#ff6b6b";ctx.fill();
    const cpt=bodyContactPoint(s.theta,p),cq=wp(cpt.x,cpt.z);ctx.beginPath();ctx.arc(cq.x,cq.y,6,0,TWO_PI);ctx.fillStyle="#ffd166";ctx.fill();
    ctx.fillStyle="#dce7f2";ctx.font="600 15px system-ui";ctx.fillText(`θ ${(s.theta*RAD2DEG).toFixed(2)}°`,20,28);ctx.font="12px system-ui";ctx.fillStyle="#91a0b1";ctx.fillText(`${prettyMode(s.mode)} / last peak ${s.lastPeakDeg.toFixed(3)}°`,20,48);
    const px=w-245,py=18;ctx.fillStyle="rgba(17,24,32,.92)";ctx.strokeStyle="#33404e";ctx.lineWidth=1;ctx.beginPath();ctx.rect(px,py,225,158);ctx.fill();ctx.stroke();
    ctx.fillStyle="#9fb0c1";ctx.fillText("PEAK-MODEL LIVE",px+12,py+18);
    const rows=[["state",s.controlState],["Afree",Number.isFinite(s.Afree)?`${s.Afree.toFixed(3)}°`:"—"],["Qcmd",`${s.qCmd.toFixed(3)} mA·s`],["Iactual",`${s.currentActualMa.toFixed(1)} mA`],["wheel",`${rpmFromRadS(s.wheelOmega).toFixed(0)} rpm`],["g model",s.modelSupported?"IN RANGE":"EXTRAPOLATION"]];
    rows.forEach((row,i)=>{const y=py+42+i*19;ctx.fillStyle="#8fa1b3";ctx.fillText(row[0],px+12,y);ctx.fillStyle="#e7f1fb";ctx.fillText(row[1],px+82,y);});
  }

  function updateFlow(s) {
    const on=(el,v)=>el.classList.toggle("active",!!v);
    const atPeak=Math.abs(s.omega*RAD2DEG)<1.0 && Math.abs(s.theta*RAD2DEG)>0.03;
    on(els.flowPeak,atPeak);on(els.flowFree,Number.isFinite(s.Afree));on(els.flowGap,Math.abs(s.deltaE)>1e-10);
    on(els.flowQ,s.qCmd>1e-8);on(els.flowCmd,Math.abs(s.currentCmdMa)>1e-6);on(els.flowCurrent,Math.abs(s.currentActualMa)>1);
    on(els.flowWheel,Math.abs(s.wheelOmega)>1e-3||Math.abs(s.omega)>1e-3);on(els.flowActualPeak,atPeak&&s.peakCount>1);
  }

  function updateLive(s,p) {
    els.liveT.textContent=s.t.toFixed(3);els.liveControl.textContent=s.controlState;
    els.liveTheta.textContent=(s.theta*RAD2DEG).toFixed(2);els.liveOmega.textContent=(s.omega*RAD2DEG).toFixed(1);
    els.livePeak.textContent=s.lastPeakDeg.toFixed(3);els.liveNextSide.textContent=sideText(s.nextSide);
    els.liveAFree.textContent=Number.isFinite(s.Afree)?s.Afree.toFixed(3):"—";els.liveARef.textContent=p.targetDeg.toFixed(3);
    els.liveDeltaE.textContent=(s.deltaE*1000).toFixed(4);els.liveQff.textContent=s.qFF.toFixed(3);
    els.liveIPlus.textContent=s.iPlus.toFixed(3);els.liveIMinus.textContent=s.iMinus.toFixed(3);els.liveQcmd.textContent=s.qCmd.toFixed(3);
    els.liveQactual.textContent=s.qEventActual.toFixed(3);els.liveICmd.textContent=s.currentCmdMa.toFixed(0);els.liveIActual.textContent=s.currentActualMa.toFixed(1);
    els.liveRpm.textContent=rpmFromRadS(s.wheelOmega).toFixed(0);els.liveWheelAngle.textContent=(s.wheelAngle*RAD2DEG).toFixed(1);
    els.liveModelStatus.textContent=s.modelSupported?"IN RANGE":"EXTRAPOLATION";
    els.liveWheelHeadroom.textContent=Number.isFinite(s.wheelQHeadroom)?s.wheelQHeadroom.toFixed(1):"∞";
    els.liveMode.textContent=prettyMode(s.mode);els.liveDecision.textContent=s.decisionText;updateFlow(s);
  }

  function chartRow(ctx,w,h,row,rowCount,label,min,max,series,cursorT,xMax,events,peaks) {
    const left=72,right=18,top=18,bottom=26,gap=10,usable=h-top-bottom-gap*(rowCount-1),rh=usable/rowCount,y0=top+row*(rh+gap),X=t=>left+(t/xMax)*(w-left-right),Y=v=>y0+rh-(v-min)/(max-min||1)*rh;
    ctx.strokeStyle="#1f2a36";for(let k=0;k<=4;k++){const y=y0+rh*k/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();}
    events.forEach(e=>{ctx.strokeStyle="rgba(255,209,102,.18)";const x=X(e.t);ctx.beginPath();ctx.moveTo(x,y0);ctx.lineTo(x,y0+rh);ctx.stroke();});
    peaks.forEach(e=>{ctx.strokeStyle="rgba(104,168,255,.12)";const x=X(e.t);ctx.beginPath();ctx.moveTo(x,y0);ctx.lineTo(x,y0+rh);ctx.stroke();});
    series.forEach(s=>{ctx.beginPath();let started=false;const stride=Math.max(1,Math.ceil(s.data.length/1400));for(let i=0;i<s.data.length;i+=stride){const pt=s.data[i],v=s.value(pt);if(!Number.isFinite(v))continue;const x=X(pt.t),y=Y(v);if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);}ctx.strokeStyle=s.color;ctx.lineWidth=s.width||2;ctx.setLineDash(s.dash||[]);ctx.stroke();ctx.setLineDash([]);});
    const cx=X(cursorT);ctx.strokeStyle="rgba(255,255,255,.9)";ctx.beginPath();ctx.moveTo(cx,y0);ctx.lineTo(cx,y0+rh);ctx.stroke();ctx.fillStyle="#92a2b3";ctx.font="11px system-ui";ctx.fillText(label,8,y0+14);ctx.fillText(max.toFixed(Math.abs(max)<10?3:1),8,y0+30);ctx.fillText(min.toFixed(Math.abs(min)<10?3:1),8,y0+rh-3);
  }

  function drawHistory(run,currentT,p) {
    const canvas=els.historyCanvas,ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle="#090e14";ctx.fillRect(0,0,w,h);if(!run||!run.samples.length)return;
    const a=run.samples,xMax=a[a.length-1].t||1,thetaMax=Math.max(p.targetDeg+1,...a.map(s=>Math.abs(s.theta*RAD2DEG)));
    chartRow(ctx,w,h,0,5,"θ body [deg]",-thetaMax,thetaMax,[{data:a,value:s=>s.theta*RAD2DEG,color:"#68a8ff"},{data:a,value:()=>p.targetDeg,color:"#7ee0b8",dash:[5,4],width:1},{data:a,value:()=>-p.targetDeg,color:"#7ee0b8",dash:[5,4],width:1}],currentT,xMax,run.events,run.peaks);
    const iMax=Math.max(p.currentMa*1.05,...a.map(s=>Math.abs(s.currentActualMa)*1.1),10);chartRow(ctx,w,h,1,5,"Current [mA]",-iMax,iMax,[{data:a,value:s=>s.currentCmdMa,color:"#91a0b1",dash:[5,4],width:1.3},{data:a,value:s=>s.currentActualMa,color:"#7ee0b8"}],currentT,xMax,run.events,run.peaks);
    const qMax=Math.max(.1,...a.map(s=>Math.max(s.qCmd,s.qFF)*1.1));chartRow(ctx,w,h,2,5,"Q cmd [mA·s]",0,qMax,[{data:a,value:s=>s.qCmd,color:"#ffd166"},{data:a,value:s=>s.qFF,color:"#ff9b72",dash:[4,3],width:1.2}],currentT,xMax,run.events,run.peaks);
    const iLim=Math.max(p.iLimitMas,.05);chartRow(ctx,w,h,3,5,"I+ / I− [mA·s]",-iLim*1.1,iLim*1.1,[{data:a,value:s=>s.iPlus,color:"#68a8ff"},{data:a,value:s=>s.iMinus,color:"#b58cff"}],currentT,xMax,run.events,run.peaks);
    const rpmAbs=Math.max(100,...a.map(s=>Math.abs(rpmFromRadS(s.wheelOmega))));chartRow(ctx,w,h,4,5,"ω wheel [rpm]",-rpmAbs*1.1,rpmAbs*1.1,[{data:a,value:s=>rpmFromRadS(s.wheelOmega),color:"#b58cff"}],currentT,xMax,run.events,run.peaks);
    ctx.fillStyle="#92a2b3";ctx.font="11px system-ui";for(let k=0;k<=6;k++){const tt=xMax*k/6,x=72+(tt/xMax)*(w-90);ctx.fillText(tt.toFixed(1),x-8,h-7);}ctx.fillText("time [s]",w-62,h-7);
  }

  function renderEvents(events) {
    els.eventBody.innerHTML="";
    events.forEach(e=>{
      const tr=document.createElement("tr");
      const vals=[e.index,e.t.toFixed(3),sideText(e.nextSide),e.Ak.toFixed(3),e.Afree.toFixed(3),e.deltaEMj.toFixed(4),e.qFF.toFixed(3),e.iUsed.toFixed(3),e.qCmd.toFixed(3),e.modelSupported?"IN":"EXTRAP",Number.isFinite(e.wheelQHeadroom)?e.wheelQHeadroom.toFixed(1):"∞",e.actualPeakDeg==null?"—":e.actualPeakDeg.toFixed(3),e.peakErrorDeg==null?"—":e.peakErrorDeg.toFixed(3)];
      vals.forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td);});els.eventBody.appendChild(tr);
    });
  }

  function sampleAtTime(samples,t) {if(!samples.length)return null;if(t<=samples[0].t)return samples[0];if(t>=samples[samples.length-1].t)return samples[samples.length-1];let lo=0,hi=samples.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(samples[mid].t<t)lo=mid;else hi=mid;}return Math.abs(samples[lo].t-t)<Math.abs(samples[hi].t-t)?samples[lo]:samples[hi];}

  function setStatus(run) {let text="START KICK → TARGET TRACK",color="#7ee0b8";if(run.invalid){text+=" / MODEL LIMIT";color="#ff7474";}else if(run.saturated){text+=" / WHEEL LIMIT";color="#ffd166";}else if(run.modelExtrapolated){text+=" / MODEL EXTRAPOLATION";color="#ffd166";}els.statusBadge.textContent=text;els.statusBadge.style.color=color;els.statusBadge.style.borderColor=color;}
  function renderAt(t){if(!activeRun||!activeParams)return;const s=sampleAtTime(activeRun.samples,t);drawMotion(s,activeParams);updateLive(s,activeParams);drawHistory(activeRun,t,activeParams);renderEvents(activeRun.events);}
  function runMain(){const p=readParams(),msgs=validateParams(p);els.validationMsg.textContent=msgs.join(" ");if(msgs.some(m=>m.startsWith("最初のピーク")||m.startsWith("目標ピーク")))return;activeParams=p;activeRun=simulatePeakController(p);playbackTime=0;playing=false;els.playBtn.textContent="▶ 再生";setStatus(activeRun);renderAt(0);}
  function animate(ts){if(!lastFrameTs)lastFrameTs=ts;const dtReal=(ts-lastFrameTs)/1000;lastFrameTs=ts;if(playing&&activeRun){playbackTime+=dtReal*(parseFloat(els.speedSelect.value)||1);const endT=activeRun.samples[activeRun.samples.length-1].t;if(playbackTime>=endT){playbackTime=endT;playing=false;els.playBtn.textContent="▶ 再生";}renderAt(playbackTime);}requestAnimationFrame(animate);}
  els.runBtn.addEventListener("click",runMain);
  els.playBtn.addEventListener("click",()=>{if(!activeRun)runMain();if(!activeRun)return;const endT=activeRun.samples[activeRun.samples.length-1].t;if(playbackTime>=endT)playbackTime=0;playing=!playing;els.playBtn.textContent=playing?"Ⅱ 一時停止":"▶ 再生";if(!playing)renderAt(playbackTime);});
  els.restartBtn.addEventListener("click",()=>{playbackTime=0;playing=false;els.playBtn.textContent="▶ 再生";renderAt(0);});

  runMain();
  requestAnimationFrame(animate);
})();
