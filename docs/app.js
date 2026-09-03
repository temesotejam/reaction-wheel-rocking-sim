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
    "initialDeg","targetDeg","currentMa","qMaxMas","energyDeadbandMj","simSeconds",
    "tauFallMs","kt","jw","maxRpm","massKg","icg","viscous","coulomb","dtMs","validationMsg",
    "liveT","liveControl","liveZc","liveTheta","liveOmega","liveENow","liveERef","liveENeed",
    "liveICmd","liveIActual","liveQTarget","liveQActual","liveTorque","liveWheelAngle","liveRpm",
    "liveMode","liveDecision","eventBody",
    "flowDecision","flowCmd","flowCurrent","flowTorque","flowWheel","flowBody"
  ].forEach(id => { els[id] = document.getElementById(id); });

  let activeRun = null;
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
    let lo = 0;
    let hi = 0.001;
    const signedProgress = w => targetSign * signedQTotalForWidth(i0Ma, commandMa, w, tauFallS);
    const targetMag = Math.abs(targetSignedQMas);
    while (signedProgress(hi) < targetMag && hi < 0.25) hi *= 2;
    hi = Math.min(hi, 0.25);
    if (signedProgress(hi) < targetMag) return hi;
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi);
      if (signedProgress(mid) < targetMag) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  function readParams() {
    const p = {
      initialDeg: finiteOr(parseFloat(els.initialDeg.value), 8),
      targetDeg: finiteOr(parseFloat(els.targetDeg.value), 10),
      currentMa: Math.max(1, finiteOr(parseFloat(els.currentMa.value), 300)),
      qMaxMas: Math.max(0.01, finiteOr(parseFloat(els.qMaxMas.value), 3.8)),
      energyDeadbandJ: Math.max(0, finiteOr(parseFloat(els.energyDeadbandMj.value), 0.015)) / 1000,
      simSeconds: clamp(finiteOr(parseFloat(els.simSeconds.value), 12), 2, 30),
      tauFall: Math.max(0.001, finiteOr(parseFloat(els.tauFallMs.value), 73) / 1000),
      kt: Math.max(1e-7, finiteOr(parseFloat(els.kt.value), 0.05)),
      jw: Math.max(1e-9, finiteOr(parseFloat(els.jw.value), 0.00008)),
      maxRpm: Math.max(100, finiteOr(parseFloat(els.maxRpm.value), 6000)),
      mass: Math.max(0.001, finiteOr(parseFloat(els.massKg.value), 0.1997)),
      icg: Math.max(1e-8, finiteOr(parseFloat(els.icg.value), 0.00055)),
      viscous: Math.max(0, finiteOr(parseFloat(els.viscous.value), 0.00012)),
      coulomb: Math.max(0, finiteOr(parseFloat(els.coulomb.value), 0.00005)),
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
    p.eRef = potential(p.targetDeg * DEG, p);
    return p;
  }

  function validateParams(p) {
    const msgs = [];
    const limit = p.thetaOuter * RAD2DEG;
    if (!(p.initialDeg > 0 && p.initialDeg < limit)) msgs.push(`初期振幅は 0〜${limit.toFixed(2)}° 未満にしてください。`);
    if (!(p.targetDeg > 0 && p.targetDeg <= limit)) msgs.push(`目標振幅は ${limit.toFixed(2)}° 以下にしてください。`);
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

  function controllerDecision(theta, omega, currentActualMa, p, zcIndex, t) {
    const eNow = rockEnergy(theta, omega, p);
    const eErr = p.eRef - eNow;
    const omegaAbs = Math.max(Math.abs(omega), 0.05);
    if (Math.abs(eErr) <= p.energyDeadbandJ) {
      return { action: "HOLD", qTarget: 0, pulseWidth: 0, commandMa: 0, eNow, eErr, omegaCross: omega, zcIndex, t };
    }
    const qRaw = Math.abs(eErr) * 1000 / (p.kt * omegaAbs);
    const qTarget = Math.min(qRaw, p.qMaxMas);
    const workSign = Math.sign(eErr);
    const wheelTorqueSign = -workSign * Math.sign(omega || 1);
    const commandMa = wheelTorqueSign * p.currentMa;
    const targetSignedQ = wheelTorqueSign * qTarget;
    const pulseWidth = solvePulseWidthForSignedQ(targetSignedQ, currentActualMa, commandMa, p.tauFall);
    return {
      action: workSign > 0 ? "ADD" : "REMOVE",
      qTarget, qRaw, pulseWidth, commandMa, eNow, eErr, omegaCross: omega, zcIndex, t
    };
  }

  function decisionText(d) {
    if (!d) return "—";
    if (d.action === "HOLD") return `ZC #${d.zcIndex}: ΔE=${(d.eErr*1000).toFixed(4)} mJ → 不感帯内のため入力なし`;
    const clipped = d.qRaw > d.qTarget + 1e-6 ? "（Q上限で制限）" : "";
    return `ZC #${d.zcIndex}: ${d.action} / ΔE=${(d.eErr*1000).toFixed(4)} mJ / Q=${d.qTarget.toFixed(3)} mA·s / Icmd=${d.commandMa.toFixed(0)} mA / ON=${(d.pulseWidth*1000).toFixed(1)} ms ${clipped}`;
  }

  function simulateContinuous(p) {
    const dt = p.dt;
    const maxSteps = Math.ceil(p.simSeconds / dt);
    const sampleEvery = Math.max(1, Math.round(0.002 / dt));
    let t = 0, theta = p.initialDeg * DEG, omega = 0;
    let wheelOmega = 0, wheelAngle = 0, currentActualMa = 0, currentCmdMa = 0;
    let activePulse = null, qEventActual = 0, qEventSigned = 0;
    let zcCount = 0, peakCount = 0, lastPeakDeg = p.initialDeg;
    let lastTheta = theta, lastOmega = omega, lastDecision = null, controlState = "COAST";
    let saturated = false, invalid = false;
    const samples = [], events = [];

    function closeEventAtNextZc() {
      if (events.length) {
        const prev = events[events.length - 1];
        if (prev.qActual == null) { prev.qActual = qEventActual; prev.qSigned = qEventSigned; }
      }
    }

    function pushSample(tauMotor) {
      const eNow = rockEnergy(theta, omega, p);
      samples.push({
        t, theta, omega, eNow, eRef: p.eRef, eErr: p.eRef - eNow,
        wheelOmega, wheelAngle, currentCmdMa, currentActualMa, tauMotor,
        qEventActual, qTarget: lastDecision ? lastDecision.qTarget : 0,
        zcCount, peakCount, lastPeakDeg, controlState,
        decisionAction: lastDecision ? lastDecision.action : "WAIT",
        decisionText: lastDecision ? decisionText(lastDecision) : "最初のゼロクロス待ち",
        mode: contactMode(theta, p)
      });
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
      if (zcCount > 0) { qEventActual += Math.abs(iMid) * dt; qEventSigned += iMid * dt; }

      let tauMotor = p.kt * (iMid / 1000);
      const wouldIncreaseWheel = wheelOmega === 0 || Math.sign(tauMotor) === Math.sign(wheelOmega);
      if (Math.abs(wheelOmega) >= p.maxWheelRadS && wouldIncreaseWheel) { tauMotor = 0; saturated = true; }

      const wheelOldOmega = wheelOmega;
      const next = rk4Body(theta, omega, tauMotor, dt, p);
      theta = next.theta; omega = next.omega;
      wheelOmega += (tauMotor / p.jw) * dt;
      if (Math.abs(wheelOmega) > p.maxWheelRadS) { wheelOmega = Math.sign(wheelOmega) * p.maxWheelRadS; saturated = true; }
      wheelAngle += 0.5 * (wheelOldOmega + wheelOmega) * dt;
      t += dt;

      if (Math.abs(currentCmdMa) > 1e-6) controlState = lastDecision && lastDecision.action === "REMOVE" ? "INPUT REMOVE" : "INPUT ADD";
      else if (Math.abs(currentActualMa) > p.currentTailThresholdMa) controlState = "CURRENT TAIL";
      else controlState = "COAST";

      if (lastOmega * omega <= 0 && Math.abs(theta) > 0.2 * DEG && Math.abs(lastOmega - omega) > 1e-9 && t > 0.02) {
        peakCount++; lastPeakDeg = Math.abs(theta) * RAD2DEG;
        if (events.length) events[events.length - 1].nextPeakDeg = lastPeakDeg;
      }

      if (lastTheta * theta <= 0 && Math.abs(lastTheta - theta) > 1e-12 && t > 0.02) {
        closeEventAtNextZc(); qEventActual = 0; qEventSigned = 0; zcCount++;
        const decision = controllerDecision(theta, omega, currentActualMa, p, zcCount, t);
        lastDecision = decision;
        events.push({
          index: zcCount, t, omegaCrossDegS: omega * RAD2DEG,
          eNowMj: decision.eNow * 1000, eErrMj: decision.eErr * 1000,
          action: decision.action, qTarget: decision.qTarget, qRaw: decision.qRaw || 0,
          pulseWidthMs: decision.pulseWidth * 1000, commandMa: decision.commandMa,
          qActual: null, nextPeakDeg: null
        });
        if (decision.action !== "HOLD" && decision.qTarget > 0 && decision.pulseWidth > 0) {
          activePulse = { start:t, end:t+decision.pulseWidth, commandMa:decision.commandMa, qTarget:decision.qTarget, action:decision.action, zcIndex:zcCount };
          controlState = decision.action === "ADD" ? "INPUT ADD" : "INPUT REMOVE";
        } else {
          activePulse = null; controlState = "HOLD";
        }
      }

      if (activePulse && t >= activePulse.end) activePulse = null;
      if (Math.abs(theta) > p.thetaOuter + 0.03 * DEG) { invalid = true; pushSample(tauMotor); break; }
      if (step % sampleEvery === 0) pushSample(tauMotor);
      lastTheta = theta; lastOmega = omega;
    }

    closeEventAtNextZc();
    return { samples, events, saturated, invalid };
  }

  function bodyContactPoint(theta, p) {
    const mag = Math.abs(theta);
    if (mag < 1e-9) return { x:0,z:0 };
    if (mag < p.thetaInner) return { x:theta>0?-p.innerX:p.innerX,z:0 };
    return { x:-p.radius*Math.sin(theta), z:p.hC0-p.radius*Math.cos(theta) };
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

  function wheelDirLabel(w) { return w>1e-3?"CCW":(w<-1e-3?"CW":"STOP"); }

  function drawRotationArrow(ctx,cx,cy,r,dir,color,width=3) {
    if(!dir)return;
    const start=dir>0?-0.55:0.55,span=dir*1.85,n=28;
    ctx.save();ctx.beginPath();
    for(let i=0;i<=n;i++){const a=start+span*i/n,x=cx+r*Math.cos(a),y=cy-r*Math.sin(a);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap="round";ctx.stroke();
    const a=start+span,tipX=cx+r*Math.cos(a),tipY=cy-r*Math.sin(a),tx=-Math.sin(a)*dir,ty=-Math.cos(a)*dir,nx=-ty,ny=tx;
    ctx.beginPath();ctx.moveTo(tipX,tipY);ctx.lineTo(tipX-tx*10+nx*5,tipY-ty*10+ny*5);ctx.lineTo(tipX-tx*10-nx*5,tipY-ty*10-ny*5);ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.restore();
  }

  function drawMotion(s,p) {
    const canvas=els.motionCanvas,ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);ctx.fillStyle="#090e14";ctx.fillRect(0,0,w,h);
    const groundY=h-62,originX=w*.5,scale=Math.min(w/.52,h/.30),sx=x=>originX+x*scale,sy=z=>groundY-z*scale;
    ctx.strokeStyle="#3a4654";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(25,groundY);ctx.lineTo(w-25,groundY);ctx.stroke();
    ctx.strokeStyle="#202a35";ctx.lineWidth=1;for(let x=35;x<w-25;x+=40){ctx.beginPath();ctx.moveTo(x,groundY+1);ctx.lineTo(x-13,groundY+12);ctx.stroke();}
    ctx.strokeStyle="#556474";ctx.beginPath();ctx.moveTo(originX,groundY-8);ctx.lineTo(originX,groundY+8);ctx.stroke();
    const wp=(x,z)=>{const q=transformBodyPoint(x,z,s.theta,p);return{x:sx(q.x),y:sy(q.z)};};
    function drawArcSegment(x0,x1){ctx.beginPath();for(let i=0;i<=36;i++){const x=x0+(x1-x0)*i/36,z=p.hC0-Math.sqrt(Math.max(0,p.radius*p.radius-x*x)),q=wp(x,z);if(i===0)ctx.moveTo(q.x,q.y);else ctx.lineTo(q.x,q.y);}ctx.strokeStyle="#aab8c7";ctx.lineWidth=8;ctx.lineCap="round";ctx.stroke();}
    drawArcSegment(-p.outerX,-p.innerX);drawArcSegment(p.innerX,p.outerX);
    const bodyPts=[wp(-.022,.018),wp(.022,.018),wp(.024,.185),wp(-.024,.185)];ctx.beginPath();bodyPts.forEach((q,i)=>i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y));ctx.closePath();ctx.fillStyle="#344658";ctx.fill();ctx.strokeStyle="#7690aa";ctx.lineWidth=2;ctx.stroke();
    const crossL=wp(-.070,.065),crossR=wp(.070,.065);ctx.beginPath();ctx.moveTo(crossL.x,crossL.y);ctx.lineTo(crossR.x,crossR.y);ctx.strokeStyle="#5f7892";ctx.lineWidth=9;ctx.stroke();
    const wheelC=wp(0,.150),wheelR=.032*scale,cmdOn=Math.abs(s.currentCmdMa)>1e-6;ctx.beginPath();ctx.arc(wheelC.x,wheelC.y,wheelR,0,TWO_PI);ctx.fillStyle="#19232e";ctx.fill();ctx.strokeStyle=cmdOn?"#7ee0b8":"#68a8ff";ctx.lineWidth=4;ctx.stroke();
    for(let k=0;k<6;k++){const a=s.wheelAngle+k*TWO_PI/6;ctx.beginPath();ctx.moveTo(wheelC.x,wheelC.y);ctx.lineTo(wheelC.x+Math.cos(a)*wheelR*.85,wheelC.y-Math.sin(a)*wheelR*.85);ctx.strokeStyle=cmdOn?"#9debc9":"#4f80b5";ctx.lineWidth=2;ctx.stroke();}
    ctx.beginPath();ctx.arc(wheelC.x,wheelC.y,5,0,TWO_PI);ctx.fillStyle="#d7e8fb";ctx.fill();const wd=s.wheelOmega>1e-3?1:(s.wheelOmega<-1e-3?-1:0);if(wd)drawRotationArrow(ctx,wheelC.x,wheelC.y,wheelR+14,wd,wd>0?"#7ee0b8":"#ffb86b");
    const cg=wp(0,p.h);ctx.beginPath();ctx.arc(cg.x,cg.y,7,0,TWO_PI);ctx.fillStyle="#ff6b6b";ctx.fill();ctx.fillStyle="#ff9b9b";ctx.font="12px system-ui";ctx.fillText("CG",cg.x+10,cg.y-8);
    ctx.fillStyle="#ffd166";if(Math.abs(s.theta)<1e-9){const qL=wp(-p.innerX,0),qR=wp(p.innerX,0);ctx.beginPath();ctx.arc(qL.x,qL.y,5,0,TWO_PI);ctx.fill();ctx.beginPath();ctx.arc(qR.x,qR.y,5,0,TWO_PI);ctx.fill();}else{const cpt=bodyContactPoint(s.theta,p),cq=wp(cpt.x,cpt.z);ctx.beginPath();ctx.arc(cq.x,cq.y,6,0,TWO_PI);ctx.fill();}
    const panelW=222,panelH=154,panelX=w-panelW-18,panelY=16;ctx.fillStyle="rgba(17,24,32,.92)";ctx.strokeStyle="#33404e";ctx.lineWidth=1;ctx.beginPath();if(typeof ctx.roundRect==="function")ctx.roundRect(panelX,panelY,panelW,panelH,10);else ctx.rect(panelX,panelY,panelW,panelH);ctx.fill();ctx.stroke();ctx.font="12px system-ui";ctx.fillStyle="#9fb0c1";ctx.fillText("LIVE @ SAME SIM TIME",panelX+12,panelY+18);
    const rows=[["control",s.controlState],["Icmd",`${s.currentCmdMa.toFixed(0)} mA`],["Iactual",`${s.currentActualMa.toFixed(1)} mA`],["Q event",`${s.qEventActual.toFixed(3)} mA·s`],["wheel",`${rpmFromRadS(s.wheelOmega).toFixed(0)} rpm / ${wheelDirLabel(s.wheelOmega)}`],["ΔE",`${(s.eErr*1000).toFixed(4)} mJ`]];rows.forEach((r,i)=>{const y=panelY+40+i*19;ctx.fillStyle="#8fa1b3";ctx.fillText(r[0],panelX+12,y);ctx.fillStyle=i===1&&cmdOn?"#7ee0b8":"#e7f1fb";ctx.fillText(r[1],panelX+82,y);});
    ctx.fillStyle="#dce7f2";ctx.font="600 15px system-ui";ctx.fillText(`θ ${(s.theta*RAD2DEG).toFixed(2)}°`,20,28);ctx.font="12px system-ui";ctx.fillStyle="#91a0b1";ctx.fillText(`${prettyMode(s.mode)} / ZC #${s.zcCount}`,20,48);
  }

  function updateFlow(s) {
    const set=(el,on)=>el.classList.toggle("active",!!on);
    const nearEvent=activeRun&&activeRun.events.some(e=>Math.abs(e.t-s.t)<.015);
    set(els.flowDecision,nearEvent);set(els.flowCmd,Math.abs(s.currentCmdMa)>1e-6);set(els.flowCurrent,Math.abs(s.currentActualMa)>1);set(els.flowTorque,Math.abs(s.tauMotor)>1e-7);set(els.flowWheel,Math.abs(s.wheelOmega)>1e-3);set(els.flowBody,Math.abs(s.omega)>1e-3);
  }

  function updateLive(s) {
    els.liveT.textContent=s.t.toFixed(3);els.liveControl.textContent=s.controlState;els.liveZc.textContent=s.zcCount;
    els.liveTheta.textContent=(s.theta*RAD2DEG).toFixed(2);els.liveOmega.textContent=(s.omega*RAD2DEG).toFixed(1);
    els.liveENow.textContent=(s.eNow*1000).toFixed(4);els.liveERef.textContent=(s.eRef*1000).toFixed(4);els.liveENeed.textContent=(s.eErr*1000).toFixed(4);
    els.liveICmd.textContent=s.currentCmdMa.toFixed(0);els.liveIActual.textContent=s.currentActualMa.toFixed(1);els.liveQTarget.textContent=s.qTarget.toFixed(3);els.liveQActual.textContent=s.qEventActual.toFixed(3);els.liveTorque.textContent=s.tauMotor.toFixed(5);
    els.liveWheelAngle.textContent=(s.wheelAngle*RAD2DEG).toFixed(1);els.liveRpm.textContent=rpmFromRadS(s.wheelOmega).toFixed(0);els.liveMode.textContent=prettyMode(s.mode);els.liveDecision.textContent=s.decisionText;updateFlow(s);
  }

  function chartRow(ctx,w,h,rowIndex,rowCount,label,yMin,yMax,series,cursorT,xMax,events) {
    const left=68,right=18,top=18,bottom=26,gap=10,usableH=h-top-bottom-gap*(rowCount-1),rowH=usableH/rowCount,y0=top+rowIndex*(rowH+gap),X=t=>left+(t/xMax)*(w-left-right),Y=v=>y0+rowH-(v-yMin)/(yMax-yMin||1)*rowH;
    ctx.strokeStyle="#1f2a36";ctx.lineWidth=1;for(let k=0;k<=4;k++){const yy=y0+rowH*k/4;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();}
    ctx.fillStyle="#92a2b3";ctx.font="11px system-ui";ctx.fillText(label,8,y0+14);ctx.fillText(yMax.toFixed(Math.abs(yMax)<10?3:1),8,y0+30);ctx.fillText(yMin.toFixed(Math.abs(yMin)<10?3:1),8,y0+rowH-3);
    events.forEach(e=>{const x=X(e.t);ctx.strokeStyle="rgba(255,209,102,.20)";ctx.beginPath();ctx.moveTo(x,y0);ctx.lineTo(x,y0+rowH);ctx.stroke();});
    series.forEach(s=>{ctx.beginPath();let started=false;const stride=Math.max(1,Math.ceil(s.data.length/1400));for(let i=0;i<s.data.length;i+=stride){const pt=s.data[i],v=s.value(pt);if(!Number.isFinite(v))continue;const x=X(pt.t),y=Y(v);if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);}ctx.strokeStyle=s.color;ctx.lineWidth=s.width||2;ctx.setLineDash(s.dash||[]);ctx.stroke();ctx.setLineDash([]);});
    const cx=X(cursorT);ctx.strokeStyle="rgba(255,255,255,.92)";ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(cx,y0);ctx.lineTo(cx,y0+rowH);ctx.stroke();
  }

  function drawHistory(run,currentT) {
    const canvas=els.historyCanvas,ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle="#090e14";ctx.fillRect(0,0,w,h);if(!run||!run.samples.length)return;
    const a=run.samples,xMax=a[a.length-1].t||1,thetaMax=Math.max(activeParams.targetDeg+2,...a.map(s=>Math.abs(s.theta*RAD2DEG)));
    chartRow(ctx,w,h,0,5,"θ body [deg]",-thetaMax,thetaMax,[{data:a,value:s=>s.theta*RAD2DEG,color:"#68a8ff"},{data:a,value:()=>activeParams.targetDeg,color:"#7ee0b8",dash:[6,5],width:1},{data:a,value:()=>-activeParams.targetDeg,color:"#7ee0b8",dash:[6,5],width:1}],currentT,xMax,run.events);
    const eMax=Math.max(activeParams.eRef*1000*1.35,...a.map(s=>s.eNow*1000),.05);chartRow(ctx,w,h,1,5,"Energy [mJ]",0,eMax,[{data:a,value:s=>s.eNow*1000,color:"#ffd166"},{data:a,value:s=>s.eRef*1000,color:"#7ee0b8",dash:[5,4]}],currentT,xMax,run.events);
    const iMax=Math.max(activeParams.currentMa*1.08,...a.map(s=>Math.abs(s.currentActualMa)*1.1),10);chartRow(ctx,w,h,2,5,"Current [mA]",-iMax,iMax,[{data:a,value:s=>s.currentCmdMa,color:"#91a0b1",dash:[5,4],width:1.4},{data:a,value:s=>s.currentActualMa,color:"#7ee0b8",width:2.2}],currentT,xMax,run.events);
    const rpmAbs=Math.max(100,...a.map(s=>Math.abs(rpmFromRadS(s.wheelOmega))));chartRow(ctx,w,h,3,5,"ω wheel [rpm]",-rpmAbs*1.1,rpmAbs*1.1,[{data:a,value:s=>rpmFromRadS(s.wheelOmega),color:"#b58cff"}],currentT,xMax,run.events);
    const angVals=a.map(s=>s.wheelAngle*RAD2DEG);let amin=Math.min(...angVals),amax=Math.max(...angVals);if(Math.abs(amax-amin)<1){amin-=1;amax+=1;}const pad=(amax-amin)*.08;chartRow(ctx,w,h,4,5,"φ wheel [deg]",amin-pad,amax+pad,[{data:a,value:s=>s.wheelAngle*RAD2DEG,color:"#ff9b72"}],currentT,xMax,run.events);
    ctx.fillStyle="#92a2b3";ctx.font="11px system-ui";for(let k=0;k<=6;k++){const t=xMax*k/6,x=68+(t/xMax)*(w-68-18);ctx.fillText(t.toFixed(1),x-8,h-7);}ctx.fillText("time [s]",w-62,h-7);
  }

  function renderEvents(events) {
    els.eventBody.innerHTML="";events.forEach(e=>{const tr=document.createElement("tr"),vals=[e.index,e.t.toFixed(3),e.omegaCrossDegS.toFixed(1),e.eNowMj.toFixed(4),e.eErrMj.toFixed(4),e.action,e.qTarget.toFixed(3),e.pulseWidthMs.toFixed(1)];vals.forEach((v,i)=>{const td=document.createElement("td");td.textContent=v;if(i===5)td.className=e.action.toLowerCase();tr.appendChild(td);});els.eventBody.appendChild(tr);});
  }

  function sampleAtTime(samples,t) {if(!samples.length)return null;if(t<=samples[0].t)return samples[0];if(t>=samples[samples.length-1].t)return samples[samples.length-1];let lo=0,hi=samples.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(samples[mid].t<t)lo=mid;else hi=mid;}return Math.abs(samples[lo].t-t)<Math.abs(samples[hi].t-t)?samples[lo]:samples[hi];}

  function setStatus(run) {let text="CONTINUOUS",color="#7ee0b8";if(run.invalid){text="MODEL LIMIT";color="#ff7474";}else if(run.saturated){text="WHEEL LIMIT";color="#ffd166";}els.statusBadge.textContent=text;els.statusBadge.style.color=color;els.statusBadge.style.borderColor=color;}

  function renderAt(t) {if(!activeRun||!activeParams)return;const s=sampleAtTime(activeRun.samples,t);drawMotion(s,activeParams);updateLive(s);drawHistory(activeRun,t);}

  function runMain() {const p=readParams(),msgs=validateParams(p);els.validationMsg.textContent=msgs.join(" ");if(msgs.some(m=>m.startsWith("初期振幅")||m.startsWith("目標振幅")))return;activeParams=p;activeRun=simulateContinuous(p);playbackTime=0;playing=false;els.playBtn.textContent="▶ 再生";setStatus(activeRun);renderEvents(activeRun.events);renderAt(0);}

  function animate(ts) {if(!lastFrameTs)lastFrameTs=ts;const dtReal=(ts-lastFrameTs)/1000;lastFrameTs=ts;if(playing&&activeRun){const speed=parseFloat(els.speedSelect.value)||1;playbackTime+=dtReal*speed;const endT=activeRun.samples[activeRun.samples.length-1].t;if(playbackTime>=endT){playbackTime=endT;playing=false;els.playBtn.textContent="▶ 再生";}renderAt(playbackTime);}requestAnimationFrame(animate);}

  els.runBtn.addEventListener("click",runMain);
  els.playBtn.addEventListener("click",()=>{if(!activeRun)runMain();if(!activeRun)return;const endT=activeRun.samples[activeRun.samples.length-1].t;if(playbackTime>=endT)playbackTime=0;playing=!playing;els.playBtn.textContent=playing?"Ⅱ 一時停止":"▶ 再生";if(!playing)renderAt(playbackTime);});
  els.restartBtn.addEventListener("click",()=>{playbackTime=0;playing=false;els.playBtn.textContent="▶ 再生";renderAt(0);});

  runMain();
  requestAnimationFrame(animate);
})();