'use strict';

let usedOnStart = 0;
let enabled = false;
let depth = 0;
let parentFn = '(tick)';

function AlreadyWrappedError() {
  this.name = 'AlreadyWrappedError';
  this.message = 'Error attempted to double wrap a function.';
  this.stack = ((new Error())).stack;
}

function setupProfiler() {
  depth = 0; // reset depth, this needs to be done each tick.
  parentFn = '(tick)';
  Game.profiler = {
    stream(duration, filter) {
      setupMemory('stream', duration || 10, filter);
    },
    email(duration, filter) {
      setupMemory('email', duration || 100, filter);
    },
    profile(duration, filter) {
      setupMemory('profile', duration || 100, filter);
    },
    background(filter) {
      setupMemory('background', false, filter);
    },
    callgrind() {
      if (!Memory.profiler || !Memory.profiler.enabledTick) {
        return 'Profiler not active.'
      }

      const id = `id${Math.random()}`;
      /* eslint-disable */
      const download = `
<script>
  var element = document.getElementById('${id}');
  if (!element) {
    element = document.createElement('a');
    element.setAttribute('id', '${id}');
    element.setAttribute('href', 'data:text/plain;charset=utf-8,${encodeURIComponent(Profiler.callgrind())}');
    element.setAttribute('download', 'callgrind.${(new Date()).toISOString().slice(0, 10)}.${Game.time}');

    element.style.display = 'none';
    document.body.appendChild(element);

    element.click();
  }
</script>
      `;
      /* eslint-enable */
      console.log(download.split('\n').map((s) => s.trim()).join(''));
    },
    restart() {
      if (Profiler.isProfiling()) {
        const filter = Memory.profiler.filter;
        let duration = false;
        if (!!Memory.profiler.disableTick) {
          // Calculate the original duration, profile is enabled on the tick after the first call,
          // so add 1.
          duration = Memory.profiler.disableTick - Memory.profiler.enabledTick + 1;
        }
        const type = Memory.profiler.type;
        setupMemory(type, duration, filter);
      }
    },
    reset: resetMemory,
    output: Profiler.output,
  };

  overloadCPUCalc();
}

function setupMemory(profileType, duration, filter) {
  resetMemory();
  const disableTick = Number.isInteger(duration) ? Game.time + duration : false;
  if (!Memory.profiler) {
    Memory.profiler = {
      map: {},
      totalTime: 0,
      enabledTick: Game.time + 1,
      disableTick,
      type: profileType,
      filter,
    };
  }
}

function resetMemory() {
  Memory.profiler = undefined;
}

function overloadCPUCalc() {
  if (Game.rooms.sim) {
    usedOnStart = 0; // This needs to be reset, but only in the sim.
    Game.cpu.getUsed = function getUsed() {
      return performance.now() - usedOnStart;
    };
  }
}

function getFilter() {
  return Memory.profiler.filter;
}

const functionBlackList = [
  'getUsed', // Let's avoid wrapping this... may lead to recursion issues and should be inexpensive.
  'constructor', // es6 class constructors need to be called with `new`
];

const commonProperties = ['length', 'name', 'arguments', 'caller', 'prototype'];

function wrapFunction(name, originalFunction) {
  if (originalFunction.profilerWrapped) { throw new AlreadyWrappedError(); }
  function wrappedFunction() {
    if (Profiler.isProfiling()) {
      const nameMatchesFilter = name === getFilter();
      if (nameMatchesFilter) {
        depth++;
      }
      const curParent = parentFn;
      parentFn = name;
      let result;

      const start = Game.cpu.getUsed()
      if (this && this.constructor === wrappedFunction) {
        // eslint-disable-next-line new-cap
        result = new originalFunction(...arguments);
      } else {
        result = originalFunction.apply(this, arguments);
      }
      const end = Game.cpu.getUsed()

      parentFn = curParent;
      if (depth > 0 || !getFilter()) {
        Profiler.record(name, end - start, parentFn);
      }
      if (nameMatchesFilter) {
        depth--;
      }
      return result;
    }

    if (this && this.constructor === wrappedFunction) {
      // eslint-disable-next-line new-cap
      return new originalFunction(...arguments);
    }
    return originalFunction.apply(this, arguments);
  }

  wrappedFunction.profilerWrapped = true;
  wrappedFunction.toString = () =>
    `// screeps-profiler wrapped function:\n${originalFunction.toString()}`;

  Object.getOwnPropertyNames(originalFunction).forEach(property => {
    if (!commonProperties.includes(property)) {
      wrappedFunction[property] = originalFunction[property];
    }
  });

  return wrappedFunction;
}

function hookUpPrototypes() {
  Profiler.prototypes.forEach(proto => {
    profileObjectFunctions(proto.val, proto.name);
  });
}

function profileObjectFunctions(object, label) {
  // prevent profiling undefined
  if (!object) {
    return;
  }

  if (object.prototype) {
    profileObjectFunctions(object.prototype, label);
  }
  const objectToWrap = object;

  Object.getOwnPropertyNames(objectToWrap).forEach(functionName => {
    const extendedLabel = `${label}.${functionName}`;

    const isBlackListed = functionBlackList.indexOf(functionName) !== -1;
    if (isBlackListed) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(objectToWrap, functionName);
    if (!descriptor) {
      return;
    }

    const hasAccessor = descriptor.get || descriptor.set;
    if (hasAccessor) {
      const configurable = descriptor.configurable;
      if (!configurable) {
        return;
      }

      const profileDescriptor = {};

      if (descriptor.get) {
        const extendedLabelGet = `${extendedLabel}:get`;
        profileDescriptor.get = profileFunction(descriptor.get, extendedLabelGet);
      }

      if (descriptor.set) {
        const extendedLabelSet = `${extendedLabel}:set`;
        profileDescriptor.set = profileFunction(descriptor.set, extendedLabelSet);
      }

      Object.defineProperty(objectToWrap, functionName, profileDescriptor);
      return;
    }

    const isFunction = typeof descriptor.value === 'function';
    if (!isFunction || !descriptor.writable) {
      return;
    }
    const originalFunction = objectToWrap[functionName];
    objectToWrap[functionName] = profileFunction(originalFunction, extendedLabel);
  });
}

function profileFunction(fn, functionName) {
  const fnName = functionName || fn.name;
  if (!fnName) {
    console.log('Couldn\'t find a function name for - ', fn);
    console.log('Will not profile this function.');
    return fn;
  }

  return wrapFunction(fnName, fn);
}

const Profiler = {
  printProfile() {
    console.log(Profiler.output());
  },

  emailProfile() {
    Game.notify(Profiler.output(1000));
  },

  callgrind() {
    const SCALE = 1000000;
    const ACTION_COST_SCALED = 0.2 * SCALE;

    const elapsedTicks = Game.time - Memory.profiler.enabledTick + 1;

    Memory.profiler.map['(tick)'].calls = elapsedTicks;
    Memory.profiler.map['(tick)'].time = Memory.profiler.totalTime;
    Profiler.checkMapItem('(root)');
    Memory.profiler.map['(root)'].calls = 1;
    Memory.profiler.map['(root)'].time = Memory.profiler.totalTime;
    Profiler.checkMapItem('(tick)', Memory.profiler.map['(root)'].subs);
    Memory.profiler.map['(root)'].subs['(tick)'].calls = elapsedTicks;
    Memory.profiler.map['(root)'].subs['(tick)'].time = Memory.profiler.totalTime;

    let uCPU_action_total = 0;
    let uCPU_wall_minus_action_total = 0;

    let body = '';
    for (const fnName of Object.keys(Memory.profiler.map)) {
      const fn = Memory.profiler.map[fnName];

      // wall time spent self, adjusted by callee loop
      let uCPU_wall_outer = fn.time * SCALE;

      // cost for just calling this successfully
      const uCPU_action_outer = this.actions.has(fnName) ? ACTION_COST_SCALED * fn.calls : 0;
      // also go to total cost
      uCPU_action_total += uCPU_action_outer;

      let callsBody = '';
      for (const callName of Object.keys(fn.subs)) {
        const call = fn.subs[callName];

        // wall time spent inside callee
        const uCPU_wall_inner = call.time * SCALE;
        // adjust self time for caller
        uCPU_wall_outer -= uCPU_wall_inner;

        // cost for just calling this successfully
        const uCPU_action_inner = this.actions.has(callName) ? ACTION_COST_SCALED * call.calls : 0;
        // also go to total cost
        uCPU_action_total += uCPU_action_inner;

        // cost for time spent without cost
        const uCPU_wall_minus_action_inner = uCPU_wall_inner - uCPU_action_inner
        // also go to total cost
        uCPU_wall_minus_action_total += uCPU_wall_minus_action_inner

        callsBody += `cfn=${callName}\ncalls=${call.calls} 1\n1 ${Math.round(uCPU_wall_inner)} ${Math.round(uCPU_action_inner)} ${Math.round(uCPU_wall_minus_action_inner)}\n`;
      }

        // cost for time spent without cost
        const uCPU_wall_minus_action_outer = uCPU_wall_outer - uCPU_action_outer
        // also go to total cost
        uCPU_wall_minus_action_total += uCPU_wall_minus_action_outer

      body += `\nfn=${fnName}\n1 ${Math.round(uCPU_wall_outer)} ${Math.round(uCPU_action_outer)} ${Math.round(uCPU_wall_minus_action_outer)}\n${callsBody}`;
    }

    const uCPU_wall_total = Memory.profiler.totalTime * SCALE;

    const headerEv1 = 'event: uCPU_wall : uCPU total\n'
    const headerEv2 = 'event: uCPU_action : uCPU [A]action cost\n'
    const headerEv3 = 'event: uCPU_wall_minus_action : uCPU without [A]action cost\n'
    const headerEvAll = 'events: uCPU_wall uCPU_action uCPU_wall_minus_action\n';

    const headerSummary = `summary: ${Math.round(uCPU_wall_total)} ${Math.round(uCPU_action_total)} ${Math.round(uCPU_wall_minus_action_total)}\n`;

    return headerEv1 + headerEv2 + headerEv3 + headerEvAll + headerSummary + body;
  },

  output(passedOutputLengthLimit) {
    const outputLengthLimit = passedOutputLengthLimit || 1000;
    if (!Memory.profiler || !Memory.profiler.enabledTick) {
      return 'Profiler not active.';
    }

    const endTick = Math.min(Memory.profiler.disableTick || Game.time, Game.time);
    const startTick = Memory.profiler.enabledTick;
    const elapsedTicks = endTick - startTick + 1;
    const header = 'calls\t\ttime\t\tavg\t\tfunction';
    const footer = [
      `Avg: ${(Memory.profiler.totalTime / elapsedTicks).toFixed(2)}`,
      `Total: ${Memory.profiler.totalTime.toFixed(2)}`,
      `Ticks: ${elapsedTicks}`,
    ].join('\t');

    const lines = [header];
    let currentLength = header.length + 1 + footer.length;
    const allLines = Profiler.lines();
    let done = false;
    while (!done && allLines.length) {
      const line = allLines.shift();
      // each line added adds the line length plus a new line character.
      if (currentLength + line.length + 1 < outputLengthLimit) {
        lines.push(line);
        currentLength += line.length + 1;
      } else {
        done = true;
      }
    }
    lines.push(footer);
    return lines.join('\n');
  },

  lines() {
    const stats = Object.keys(Memory.profiler.map).map(functionName => {
      const functionCalls = Memory.profiler.map[functionName];
      return {
        name: functionName,
        calls: functionCalls.calls,
        totalTime: functionCalls.time,
        averageTime: functionCalls.time / functionCalls.calls,
      };
    }).sort((val1, val2) => {
      return val2.totalTime - val1.totalTime;
    });

    const lines = stats.map(data => {
      return [
        data.calls,
        data.totalTime.toFixed(1),
        data.averageTime.toFixed(3),
        data.name,
      ].join('\t\t');
    });

    return lines;
  },

  prototypes: [
    { name: 'Game', val: Game },
    // InterShardMemory
    { name: 'Map', val: Game.map },
    { name: 'Market', val: Game.market },
    // Memory
    { name: 'PathFinder', val: PathFinder },
    { name: 'RawMemory', val: RawMemory },
    { name: 'ConstructionSite', val: ConstructionSite },
    { name: 'Creep', val: Creep },
    { name: 'Deposit', val: Deposit },
    { name: 'Flag', val: Flag },
    { name: 'Mineral', val: Mineral },
    { name: 'Nuke', val: Nuke },
    { name: 'OwnedStructure', val: OwnedStructure },
    { name: 'CostMatrix', val: PathFinder.CostMatrix },
    { name: 'PowerCreep', val: PowerCreep },
    { name: 'Resource', val: Resource },
    { name: 'Room', val: Room },
    { name: 'Terrain', val: Room.Terrain },
    { name: 'RoomObject', val: RoomObject },
    { name: 'RoomPosition', val: RoomPosition },
    { name: 'RoomVisual', val: RoomVisual },
    { name: 'Ruin', val: Ruin },
    { name: 'Source', val: Source },
    { name: 'Store', val: Store },
    { name: 'Structure', val: Structure },
    { name: 'StructureContainer', val: StructureContainer },
    { name: 'StructureController', val: StructureController },
    { name: 'StructureExtension', val: StructureExtension },
    { name: 'StructureExtractor', val: StructureExtractor },
    { name: 'StructureFactory', val: StructureFactory },
    { name: 'StructureInvaderCore', val: StructureInvaderCore },
    { name: 'StructureKeeperLair', val: StructureKeeperLair },
    { name: 'StructureLab', val: StructureLab },
    { name: 'StructureLink', val: StructureLink },
    { name: 'StructureNuker', val: StructureNuker },
    { name: 'StructureObserver', val: StructureObserver },
    { name: 'StructurePowerBank', val: StructurePowerBank },
    { name: 'StructurePowerSpawn', val: StructurePowerSpawn },
    { name: 'StructurePortal', val: StructurePortal },
    { name: 'StructureRampart', val: StructureRampart },
    { name: 'StructureRoad', val: StructureRoad },
    { name: 'StructureSpawn', val: StructureSpawn },
    // StructureSpawn.Spawning
    { name: 'StructureStorage', val: StructureStorage },
    { name: 'StructureTerminal', val: StructureTerminal },
    { name: 'StructureTower', val: StructureTower },
    { name: 'StructureWall', val: StructureWall },
    { name: 'Tombstone', val: Tombstone }
  ],

  actions: new Set([
    'Game.notify',
    'Market.cancelOrder',
    'Market.changeOrderPrice',
    'Market.createOrder',
    'Market.deal',
    'Market.extendOrder',
    'ConstructionSite.remove',
    'Creep.attack',
    'Creep.attackController',
    'Creep.build',
    'Creep.claimController',
    'Creep.dismantle',
    'Creep.drop',
    'Creep.generateSafeMode',
    'Creep.harvest',
    'Creep.heal',
    'Creep.move',
    'Creep.notifyWhenAttacked',
    'Creep.pickup',
    'Creep.rangedAttack',
    'Creep.rangedHeal',
    'Creep.rangedMassAttack',
    'Creep.repair',
    'Creep.reserveController',
    'Creep.signController',
    'Creep.suicide',
    'Creep.transfer',
    'Creep.upgradeController',
    'Creep.withdraw',
    'Flag.remove',
    'Flag.setColor',
    'Flag.setPosition',
    'OwnedStructure.destroy',
    'OwnedStructure.notifyWhenAttacked',
    'PowerCreep.delete',
    'PowerCreep.drop',
    'PowerCreep.enableRoom',
    'PowerCreep.move',
    'PowerCreep.notifyWhenAttacked',
    'PowerCreep.pickup',
    'PowerCreep.renew',
    'PowerCreep.spawn',
    'PowerCreep.suicide',
    'PowerCreep.transfer',
    'PowerCreep.upgrade',
    'PowerCreep.usePower',
    'PowerCreep.withdraw',
    'Room.createConstructionSite',
    'Room.createFlag',
    'RoomPosition.createConstructionSite',
    'RoomPosition.createFlag',
    'Structure.destroy',
    'Structure.notifyWhenAttacked',
    'StructureController.activateSafeMode',
    'StructureController.unclaim',
    'StructureExtension.destroy',
    'StructureExtension.notifyWhenAttacked',
    'StructureExtractor.destroy',
    'StructureExtractor.notifyWhenAttacked',
    'StructureFactory.destroy',
    'StructureFactory.notifyWhenAttacked',
    'StructureFactory.produce',
    'StructureInvaderCore.destroy',
    'StructureInvaderCore.notifyWhenAttacked',
    'StructureKeeperLair.destroy',
    'StructureKeeperLair.notifyWhenAttacked',
    'StructureLab.destroy',
    'StructureLab.notifyWhenAttacked',
    'StructureLab.boostCreep',
    'StructureLab.reverseReaction',
    'StructureLab.runReaction',
    'StructureLab.unboostCreep',
    'StructureLink.destroy',
    'StructureLink.notifyWhenAttacked',
    'StructureLink.transferEnergy',
    'StructureNuker.destroy',
    'StructureNuker.notifyWhenAttacked',
    'StructureNuker.launchNuke',
    'StructureObserver.destroy',
    'StructureObserver.notifyWhenAttacked',
    'StructureObserver.observe',
    'StructurePowerBank.destroy',
    'StructurePowerBank.notifyWhenAttacked',
    'StructurePowerSpawn.destroy',
    'StructurePowerSpawn.notifyWhenAttacked',
    'StructurePowerSpawn.processPower',
    'StructurePortal.destroy',
    'StructurePortal.notifyWhenAttacked',
    'StructureRampart.destroy',
    'StructureRampart.notifyWhenAttacked',
    'StructureRampart.setPublic',
    'StructureRoad.destroy',
    'StructureRoad.notifyWhenAttacked',
    'StructureSpawn.destroy',
    'StructureSpawn.notifyWhenAttacked',
    'StructureSpawn.createCreep',
    'StructureSpawn.spawnCreep',
    'StructureSpawn.recycleCreep',
    'StructureSpawn.renewCreep',
    // StructureSpawn.Spawning.cancel
    // StructureSpawn.Spawning.setDirections
    'StructureStorage.destroy',
    'StructureStorage.notifyWhenAttacked',
    'StructureTerminal.destroy',
    'StructureTerminal.notifyWhenAttacked',
    'StructureTerminal.send',
    'StructureTower.destroy',
    'StructureTower.notifyWhenAttacked',
    'StructureTower.heal',
    'StructureTower.attack',
    'StructureTower.repair',
    'StructureWall.destroy',
    'StructureWall.notifyWhenAttacked'
  ]),

  checkMapItem(functionName, map = Memory.profiler.map) {
    if (!map[functionName]) {
      // eslint-disable-next-line no-param-reassign
      map[functionName] = {
        time: 0,
        calls: 0,
        subs: {},
      };
    }
  },

  record(functionName, time, parent) {
    this.checkMapItem(functionName);
    Memory.profiler.map[functionName].calls++;
    Memory.profiler.map[functionName].time += time;
    if (parent) {
      this.checkMapItem(parent);
      this.checkMapItem(functionName, Memory.profiler.map[parent].subs);
      Memory.profiler.map[parent].subs[functionName].calls++;
      Memory.profiler.map[parent].subs[functionName].time += time;
    }
  },

  endTick() {
    if (Game.time >= Memory.profiler.enabledTick) {
      const cpuUsed = Game.cpu.getUsed();
      Memory.profiler.totalTime += cpuUsed;
      Profiler.report();
    }
  },

  report() {
    if (Profiler.shouldPrint()) {
      Profiler.printProfile();
    } else if (Profiler.shouldEmail()) {
      Profiler.emailProfile();
    }
  },

  isProfiling() {
    if (!enabled || !Memory.profiler) {
      return false;
    }
    return !Memory.profiler.disableTick || Game.time <= Memory.profiler.disableTick;
  },

  type() {
    return Memory.profiler.type;
  },

  shouldPrint() {
    const streaming = Profiler.type() === 'stream';
    const profiling = Profiler.type() === 'profile';
    const onEndingTick = Memory.profiler.disableTick === Game.time;
    return streaming || (profiling && onEndingTick);
  },

  shouldEmail() {
    return Profiler.type() === 'email' && Memory.profiler.disableTick === Game.time;
  },
};

module.exports = {
  wrap(callback) {
    if (enabled) {
      setupProfiler();
    }

    if (Profiler.isProfiling()) {
      usedOnStart = Game.cpu.getUsed();

      // Commented lines are part of an on going experiment to keep the profiler
      // performant, and measure certain types of overhead.

      // var callbackStart = Game.cpu.getUsed();
      const returnVal = callback();
      // var callbackEnd = Game.cpu.getUsed();
      Profiler.endTick();
      // var end = Game.cpu.getUsed();

      // var profilerTime = (end - start) - (callbackEnd - callbackStart);
      // var callbackTime = callbackEnd - callbackStart;
      // var unaccounted = end - profilerTime - callbackTime;
      // console.log('total-', end, 'profiler-', profilerTime, 'callbacktime-',
      // callbackTime, 'start-', start, 'unaccounted', unaccounted);
      return returnVal;
    }

    return callback();
  },

  enable() {
    enabled = true;
    hookUpPrototypes();
  },

  disable() {
    enabled = false;
  },

  output: Profiler.output,
  callgrind: Profiler.callgrind,

  registerObject: profileObjectFunctions,
  registerFN: profileFunction,
  registerClass: profileObjectFunctions,
};
