// Library imports
var WebSocket = require('ws');
var fs = require("fs");
var ini = require('./modules/ini.js');

// Project imports
var Packet = require('./packet');
var PlayerTracker = require('./PlayerTracker');
var PacketHandler = require('./PacketHandler');
var Entity = require('./entity');
var Gamemode = require('./gamemodes');
var BotLoader = require('./ai/BotLoader.js');

// GameServer implementation
function GameServer(realmID,confile) {
    // Master server stuff
    this.realmID = realmID;
    this.masterServer;

    // Startup 
    this.run = true;
    this.lastNodeId = 1;
    this.lastPlayerId = 1;
    this.clients = [];
    this.nodes = [];
    this.nodesVirus = []; // Virus nodes
    this.nodesEjected = []; // Ejected mass nodes
    this.nodesPlayer = []; // Nodes controlled by players

    this.currentFood = 0;
    this.movingNodes = []; // For move engine
    this.leaderboard = [];
    this.lb_packet = new ArrayBuffer(0); // Leaderboard packet

    this.bots = new BotLoader(this);
    this.commands; // Command handler
    this.banned = []; // List of banned IPs

    // Main loop tick
    this.time = new Date();
    this.tick = 0; // 1 second ticks of mainLoop
    this.tickMain = 0; // 50 ms ticks, 20 of these = 1 leaderboard update
    this.tickSpawn = 0; // Used with spawning food

    // Config
    this.config = { // Border - Right: X increases, Down: Y increases (as of 2015-05-20)
        serverMaxConnections: 64, // Maximum amount of connections to the server.
        serverPort: 443, // Server port
        serverGamemode: 0, // Gamemode, 0 = FFA, 1 = Teams
        serverBots: 0, // Amount of player bots to spawn
        serverViewBase: 1024, // Base view distance of players. Warning: high values may cause lag
        useWithMaster: false,
        masterIP: "127.0.0.1",
        masterCommands: false,
        masterUpdate: 45,
        borderLeft: 0, // Left border of map (Vanilla value: 0)
        borderRight: 6000, // Right border of map (Vanilla value: 11180.3398875)
        borderTop: 0, // Top border of map (Vanilla value: 0)
        borderBottom: 6000, // Bottom border of map (Vanilla value: 11180.3398875)
        spawnInterval: 20, // The interval between each food cell spawn in ticks (1 tick = 50 ms)
        foodSpawnAmount: 10, // The amount of food to spawn per interval
        foodStartAmount: 100, // The starting amount of food in the map
        foodMaxAmount: 500, // Maximum food cells on the map
        foodMass: 1, // Starting food size (In mass)
        virusMinAmount: 10, // Minimum amount of viruses on the map.
        virusMaxAmount: 50, // Maximum amount of viruses on the map. If this amount is reached, then ejected cells will pass through viruses.
        virusStartMass: 100, // Starting virus size (In mass)
        virusFeedAmount: 7, // Amount of times you need to feed a virus to shoot it
        ejectMass: 12, // Mass of ejected cells
        ejectMassLoss: 16, // Mass lost when ejecting cells
        ejectSpeed: 160, // Base speed of ejected cells
        ejectSpawnPlayer: 50, // Chance for a player to spawn from ejected mass
        playerStartMass: 10, // Starting mass of the player cell.
        playerMaxMass: 22500, // Maximum mass a player can have
        playerMinMassEject: 32, // Mass required to eject a cell
        playerMinMassSplit: 36, // Mass required to split
        playerMaxCells: 16, // Max cells the player is allowed to have
        playerRecombineTime: 30, // Base amount of seconds before a cell is allowed to recombine
        playerMassDecayRate: .002, // Amount of mass lost per second
        playerMinMassDecay: 9, // Minimum mass for decay to occur
        playerMaxNickLength: 15, // Maximum nick length
        playerDisconnectTime: 60, // The amount of seconds it takes for a player cell to be removed after disconnection (If set to -1, cells are never removed)
        tourneyMaxPlayers: 12, // Maximum amount of participants for tournament style game modes
        tourneyPrepTime: 10, // Amount of ticks to wait after all players are ready (1 tick = 1000 ms)
        tourneyEndTime: 30, // Amount of ticks to wait after a player wins (1 tick = 1000 ms)
        tourneyAutoFill: 0, // If set to a value higher than 0, the tournament match will automatically fill up with bots after this amount of seconds
        tourneyAutoFillPlayers: 1, // The timer for filling the server with bots will not count down unless there is this amount of real players
        chatMaxMessageLength: 200, // Maximum message length
    };
    // Parse config
    this.loadConfig(confile);

    // Gamemodes
    this.gameMode = Gamemode.get(this.config.serverGamemode);

    // Colors
    this.colors = [
        {'r':235, 'g': 75, 'b':  0},
        {'r':225, 'g':125, 'b':255},
        {'r':180, 'g':  7, 'b': 20},
        {'r': 80, 'g':170, 'b':240},
        {'r':180, 'g': 90, 'b':135},
        {'r':195, 'g':240, 'b':  0},
        {'r':150, 'g': 18, 'b':255},
        {'r': 80, 'g':245, 'b':  0},
        {'r':165, 'g': 25, 'b':  0},
        {'r': 80, 'g':145, 'b':  0},
        {'r': 80, 'g':170, 'b':240},
        {'r': 55, 'g': 92, 'b':255},
    ];

    // Debug
    this.debug = false;
    this.tickDebug = 0;
}

module.exports = GameServer;

GameServer.prototype.start = function() {
    // Gamemode configurations
    this.gameMode.onServerInit(this);

    // Start the server
    this.socketServer = new WebSocket.Server({ port: this.config.serverPort, perMessageDeflate: false}, function() {
        // Spawn starting food
        this.startingFood();

        // Start Main Loop
        setInterval(function(){this.mainLoop.bind(this)}, 1);

        // Done
        console.log("[Game:"+this.realmID+"] Game Server started at port %d", this.config.serverPort);
        console.log("[Game:"+this.realmID+"] Current game mode is "+this.gameMode.name);

        // Player bots (Experimental)
        if (this.config.serverBots > 0) {
            for (var i = 0;i < this.config.serverBots;i++) {
                this.bots.addBot();
            }
            console.log("[Game:"+this.realmID+"] Loaded "+this.config.serverBots+" player bots");
        }
    }.bind(this));

    this.socketServer.on('connection', connectionEstablished.bind(this));

    // Properly handle errors because some people are too lazy to read the readme
    this.socketServer.on('error', function err(e) {
        switch (e.code) {
            case "EADDRINUSE": 
                console.log("[Error] Server could not bind to port! Please close out of Skype or change 'serverPort' in gameserver.ini to a different number.");
                break;
            case "EACCES": 
                console.log("[Error] Please make sure you are running Ogar with root privileges.");
                break;
            default:
                console.log("[Error] Unhandled error code: "+e.code);
                break;
        }
        process.exit(1); // Exits the program
    });

    function connectionEstablished(ws) {
        if (this.clients.length > this.config.serverMaxConnections) { // Server full
            ws.close();
            console.log("[Game:"+this.realmID+"] Client tried to connect, but server player limit has been reached!");
            return;
        } else if (this.banned.indexOf(ws._socket.remoteAddress) != -1) { // Banned
            ws.close();
            return;
        }

        // Master server stuff
        if ((this.config.masterIP == ws._socket.remoteAddress) && (!this.masterServer) && (this.config.useWithMaster)) {
            ws.gameServer = this;

            ws.on('message', function recv(msg) {
                if (msg.charAt(0) == 'H') {
                    ws.gameServer.realmID = parseInt(msg.split('Hi')[1]);
                    ws.send('Hello'); // Response
                    console.log(ws.gameServer.getName()+" Connected to master server");
                    // Send stats
                    var stats = {
                        players: ws.gameServer.clients.length,
                        max: ws.gameServer.config.serverMaxConnections,
                        mode: ws.gameServer.gameMode.name,
                    };
                    ws.gameServer.masterServer.send(JSON.stringify(stats)); 
                    // Connection established
                    if (ws.gameServer.config.masterCommands) {
                        // Override
                        ws.on('message', function recv(msg) {
                            var split = msg.split(' ');
                            var execute = ws.gameServer.commands[split[0]];
                            if (execute) {
                                execute(ws.gameServer,split);
                            } else {
                                console.log(ws.gameServer.getName()+" Invalid command!");
                            }
                        });
                    } else {
                        ws.on('message', function recv(msg) { /* Nothing */ });
                    }
                }
            });

            this.masterServer = ws;

            this.masterServer.timer = setInterval(function() {
                try {
                    var stats = {
                        players: this.clients.length,
                        max: this.config.serverMaxConnections,
                        mode: this.gameMode.name,
                    };
                    this.masterServer.send(JSON.stringify(stats));
                } catch (e) {
                    console.log(this.getName()+" Master server disconnected!");
                    clearInterval(this.masterServer.timer);
                    this.masterServer.close();
                    this.masterServer = null;
                }
            }.bind(this), this.config.masterUpdate * 1000); 
            return;
        }

        // Back to game server stuff
        function close(error) {
            //console.log("[Game] Disconnect: "+error);

            var client = this.socket.playerTracker;
            var len = this.socket.playerTracker.cells.length;
            for (var i = 0; i < len; i++) {
                var cell = this.socket.playerTracker.cells[i];

                if (!cell) {
                    continue;
                }

                cell.disconnect = this.server.config.playerDisconnectTime;
                cell.calcMove = function() {return;}; // Clear function so that the cell cant move
                //this.server.removeNode(cell);
            }

            var index = this.server.clients.indexOf(this.socket);
            if (index != -1) {
                this.server.clients.splice(index, 1);
            }
        }

        // console.log("[Game] Connect: %s:%d", ws._socket.remoteAddress, ws._socket.remotePort);
        ws.remoteAddress = ws._socket.remoteAddress;
        ws.remotePort = ws._socket.remotePort;
        ws.playerTracker = new PlayerTracker(this, ws);
        ws.packetHandler = new PacketHandler(this, ws);
        ws.on('message', ws.packetHandler.handleMessage.bind(ws.packetHandler));

        var bindObject = { server: this, socket: ws };
        ws.on('error', close.bind(bindObject));
        ws.on('close', close.bind(bindObject));
        this.clients.push(ws);

    }

};

GameServer.prototype.getName = function() {
    // Gets the name of this server. For use in the console
    return "[Game:"+this.realmID+"]";
}

GameServer.prototype.getMode = function() {
    return this.gameMode;
};

GameServer.prototype.getNextNodeId = function() {
    // Resets integer
    if (this.lastNodeId > 2147483647) {
        this.lastNodeId = 1;
    }
    return this.lastNodeId++;
};

GameServer.prototype.getNewPlayerID = function() {
    // Resets integer
    if (this.lastPlayerId > 2147483647) {
        this.lastPlayerId = 1;
    }
    return this.lastPlayerId++;
};

GameServer.prototype.getRandomPosition = function() {
    return {
        x: Math.floor(Math.random() * (this.config.borderRight - this.config.borderLeft)) + this.config.borderLeft,
        y: Math.floor(Math.random() * (this.config.borderBottom - this.config.borderTop)) + this.config.borderTop
    };
};

GameServer.prototype.getRandomColor = function() {
    var index = Math.floor(Math.random() * this.colors.length);
    var color = this.colors[index];
    return {
        r: color.r,
        b: color.b,
        g: color.g
    };
};

GameServer.prototype.addNode = function(node) {
    this.nodes.push(node);

    // Adds to the owning player's screen
    if (node.owner) {
        node.setColor(node.owner.color);
        node.owner.cells.push(node);
        node.owner.socket.sendPacket(new Packet.AddNode(node));
    }

    // Special on-add actions
    node.onAdd(this);

    // Add to visible nodes
    for (var i = 0; i < this.clients.length;i++) {
        client = this.clients[i].playerTracker;
        if (!client) {
            continue;
        }

        // client.nodeAdditionQueue is only used by human players, not bots
        // for bots it just gets collected forever, using ever-increasing amounts of memory
        if ('_socket' in client.socket && node.visibleCheck(client.viewBox,client.centerPos)) {
            client.nodeAdditionQueue.push(node);
        }
    }
};

GameServer.prototype.removeNode = function(node) {
    // Remove from main nodes list
    var index = this.nodes.indexOf(node);
    if (index != -1) {
        this.nodes.splice(index, 1);
    }

    // Remove from moving cells list
    index = this.movingNodes.indexOf(node);
    if (index != -1) {
        this.movingNodes.splice(index, 1);
    }

    // Special on-remove actions
    node.onRemove(this);

    // Animation when eating
    for (var i = 0; i < this.clients.length;i++) {
        client = this.clients[i].playerTracker;
        if (!client) {
            continue;
        }
        // Remove from client
        client.nodeDestroyQueue.push(node);
    }
};

GameServer.prototype.cellTick = function() {
    // Move cells
    this.updateMoveEngine();
}

GameServer.prototype.spawnTick = function() {
    // Spawn food
    this.tickSpawn++;
    if (this.tickSpawn >= this.config.spawnInterval) {
        this.updateFood(); // Spawn food
        this.virusCheck(); // Spawn viruses

        this.tickSpawn = 0; // Reset
    }
}

GameServer.prototype.gamemodeTick = function() {
    // Gamemode tick
    this.gameMode.onTick(this);
}

GameServer.prototype.cellUpdateTick = function() {
    // Update cells
    this.updateCells();
}


GameServer.prototype.mainLoop = function() {
    // Timer
    var local = new Date();
    this.tick += (local - this.time);
    this.time = local;

    if (this.tick >= 50) {
        // Loop main functions
        if (this.run) {
       this.cellTick()
            this.spawnTick()
            this.gamemodeTick()
        }

        // Update the client's maps
        this.updateClients();

        // Update cells/leaderboard loop
        this.tickMain++;
        if (this.tickMain >= 20) { // 1 Second
           this.cellUpdateTick()

            // Update leaderboard with the gamemode's method
            this.leaderboard = [];
            this.gameMode.updateLB(this);
            this.lb_packet = new Packet.UpdateLeaderboard(this.leaderboard,this.gameMode.packetLB);

            this.tickMain = 0; // Reset
        }

        // Reset
        this.tick = 0;
    }
};


GameServer.prototype.updateClients = function() {
    for (var i = 0; i < this.clients.length; i++) {
        if (typeof this.clients[i] == "undefined") {
            continue;
        }

        this.clients[i].playerTracker.update();
    }
};

GameServer.prototype.startingFood = function() {
    // Spawns the starting amount of food cells
    for (var i = 0; i < this.config.foodStartAmount; i++) {
        this.spawnFood();
    }
};

GameServer.prototype.updateFood = function() {
    var toSpawn = Math.min(this.config.foodSpawnAmount,(this.config.foodMaxAmount-this.currentFood));
    for (var i = 0; i < toSpawn; i++) {
        this.spawnFood();
    }
};

GameServer.prototype.spawnFood = function() {
    var f = new Entity.Food(this.getNextNodeId(), null, this.getRandomPosition(), this.config.foodMass);
    f.setColor(this.getRandomColor());

    this.addNode(f);
    this.currentFood++;
};

GameServer.prototype.spawnPlayer = function(player,pos,mass) {
	if (pos == null) { // Get random pos
		pos = this.getRandomPosition();
	}
	if (mass == null) { // Get starting mass
		mass = this.config.playerStartMass;
	}
	
    // Spawn player and add to world
    var cell = new Entity.PlayerCell(this.getNextNodeId(), player, pos, mass);
    this.addNode(cell);

    // Set initial mouse coords
    player.mouse = {x: pos.x, y: pos.y};
};

GameServer.prototype.virusCheck = function() {
    // Checks if there are enough viruses on the map
    if (this.nodesVirus.length < this.config.virusMinAmount) {
        // Spawns a virus
        var pos = this.getRandomPosition();

        // Check for players
        for (var i = 0; i < this.nodesPlayer.length; i++) {
            var check = this.nodesPlayer[i];

            if (check.mass < this.config.virusStartMass) {
                continue;
            }

            var r = check.getSize(); // Radius of checking player cell

            // Collision box
            var topY = check.position.y - r;
            var bottomY = check.position.y + r;
            var leftX = check.position.x - r;
            var rightX = check.position.x + r;

            // Check for collisions
            if (pos.y > bottomY) {
                continue;
            }

            if (pos.y < topY) {
                continue;
            }

            if (pos.x > rightX) {
                continue;
            }

            if (pos.x < leftX) {
                continue;
            }

            // Collided
            return;
        }

        // Spawn if no cells are colliding
        var v = new Entity.Virus(this.getNextNodeId(), null, pos, this.config.virusStartMass);
        this.addNode(v);
    }
};

GameServer.prototype.updateMoveEngine = function() {
    // Move player cells
    var len = this.nodesPlayer.length;
    for (var i = 0; i < len; i++) {
        var cell = this.nodesPlayer[i];

        // Do not move cells that have already been eaten or have collision turned off
        if ((!cell) || (cell.ignoreCollision)){
            continue;
        }

        var client = cell.owner;

        cell.calcMove(client.mouse.x, client.mouse.y, this);

        // Check if cells nearby
        var list = this.getCellsInRange(cell);
        for (var j = 0; j < list.length ; j++) {
            var check = list[j];

            // if we're deleting from this.nodesPlayer, fix outer loop variables; we need to update its length, and maybe 'i' too
            if (check.cellType == 0) {
                len--;
                if (check.nodeId < cell.nodeId) {
                    i--;
                }
            }

            // Consume effect
            check.onConsume(cell,this);

            // Remove cell
            check.setKiller(cell);
            this.removeNode(check);
        }
    }

    // A system to move cells not controlled by players (ex. viruses, ejected mass)
    len = this.movingNodes.length;
    for (var i = 0; i < len; i++) {
        var check = this.movingNodes[i];

        // Recycle unused nodes
        while ((typeof check == "undefined") && (i < this.movingNodes.length)) {
            // Remove moving cells that are undefined
            this.movingNodes.splice(i, 1);
            check = this.movingNodes[i];
        }

        if (i >= this.movingNodes.length) {
            continue;
        }

        if (check.moveEngineTicks > 0) {
            check.onAutoMove(this);
            // If the cell has enough move ticks, then move it
            check.calcMovePhys(this.config);
        } else {
            // Auto move is done
            check.moveDone(this);
            // Remove cell from list
            var index = this.movingNodes.indexOf(check);
            if (index != -1) {
                this.movingNodes.splice(index, 1);
            }
        }
    }
};

GameServer.prototype.setAsMovingNode = function(node) {
    this.movingNodes.push(node);
};

GameServer.prototype.splitCells = function(client) {
    var len = client.cells.length;
    for (var i = 0; i < len; i++) {
        if (client.cells.length >= this.config.playerMaxCells) {
            // Player cell limit
            continue;
        }

        var cell = client.cells[i];
        if (!cell) {
            continue;
        }

        if (cell.mass < this.config.playerMinMassSplit) {
            continue;
        }

        // Get angle
        var deltaY = client.mouse.y - cell.position.y;
        var deltaX = client.mouse.x - cell.position.x;
        var angle = Math.atan2(deltaX,deltaY);

        // Get starting position
        var size = cell.getSize()/2;
        var startPos = {
            x: cell.position.x + ( size * Math.sin(angle) ),
            y: cell.position.y + ( size * Math.cos(angle) )
        };
        // Calculate mass and speed of splitting cell
        var splitSpeed = cell.getSpeed() * 6;
        var newMass = cell.mass / 2;
        cell.mass = newMass;
        // Create cell
        var split = new Entity.PlayerCell(this.getNextNodeId(), client, startPos, newMass);
        split.setAngle(angle);
        split.setMoveEngineData(splitSpeed, 32, 0.85); 
        split.calcMergeTime(this.config.playerRecombineTime);

        // Add to moving cells list
        this.setAsMovingNode(split);
        this.addNode(split);
    }
};

GameServer.prototype.ejectMass = function(client) {
    for (var i = 0; i < client.cells.length; i++) {
        var cell = client.cells[i];

        if (!cell) {
            continue;
        }

        if (cell.mass < this.config.playerMinMassEject) {
            continue;
        }

        var deltaY = client.mouse.y - cell.position.y;
        var deltaX = client.mouse.x - cell.position.x;
        var angle = Math.atan2(deltaX,deltaY);

        // Get starting position
        var size = cell.getSize() + 5;
        var startPos = {
            x: cell.position.x + ( (size + this.config.ejectMass) * Math.sin(angle) ),
            y: cell.position.y + ( (size + this.config.ejectMass) * Math.cos(angle) )
        };

        // Remove mass from parent cell
        cell.mass -= this.config.ejectMassLoss;
        // Randomize angle
        angle += (Math.random() * .4) - .2;

        // Create cell
        var ejected = new Entity.EjectedMass(this.getNextNodeId(), null, startPos, this.config.ejectMass);
        ejected.setAngle(angle);
        ejected.setMoveEngineData(this.config.ejectSpeed, 20);
        ejected.setColor(cell.getColor());

        this.addNode(ejected);
        this.setAsMovingNode(ejected);
    }
};

GameServer.prototype.newCellVirused = function(client, parent, angle, mass, speed) {
    // Starting position
    var startPos = {
        x: parent.position.x,
        y: parent.position.y
    };

    // Create cell
    newCell = new Entity.PlayerCell(this.getNextNodeId(), client, startPos, mass);
    newCell.setAngle(angle);
    newCell.setMoveEngineData(speed, 10);
    newCell.calcMergeTime(this.config.playerRecombineTime);
    newCell.ignoreCollision = true;  // Turn off collision

    // Add to moving cells list
    this.addNode(newCell);
    this.setAsMovingNode(newCell);
};

GameServer.prototype.shootVirus = function(parent) {
    var parentPos = {
        x: parent.position.x,
        y: parent.position.y,
    };

    var newVirus = new Entity.Virus(this.getNextNodeId(), null, parentPos, this.config.virusStartMass);
    newVirus.setAngle(parent.getAngle());
    newVirus.setMoveEngineData(200, 20);

    // Add to moving cells list
    this.addNode(newVirus);
    this.setAsMovingNode(newVirus);
};

GameServer.prototype.getCellsInRange = function(cell) {
    var list = new Array();
    var r = cell.getSize(); // Get cell radius (Cell size = radius)

    var topY = cell.position.y - r;
    var bottomY = cell.position.y + r;

    var leftX = cell.position.x - r;
    var rightX = cell.position.x + r;

    // Loop through all cells that are visible to the cell. There is probably a more efficient way of doing this but whatever
    var len = cell.owner.visibleNodes.length;
    for (var i = 0;i < len;i++) {
        var check = cell.owner.visibleNodes[i];

        if (typeof check === 'undefined') {
            continue;
        }

        // if something already collided with this cell, don't check for other collisions
        if (check.inRange) {
            continue;
        }

        // Can't eat itself
        if (cell.nodeId == check.nodeId) {
            continue;
        }

        // Can't eat cells that have collision turned off
        if ((cell.owner == check.owner) && (cell.ignoreCollision)) {
            continue;
        }

        // AABB Collision
        if (!check.collisionCheck(bottomY,topY,rightX,leftX)) {
            continue;
        }

        // Cell type check - Cell must be bigger than this number times the mass of the cell being eaten
        var multiplier = 1.25;

        switch (check.getType()) {
            case 1: // Food cell
                list.push(check);
                check.inRange = true; // skip future collision checks for this food
                continue;
            case 2: // Virus
                multiplier = 1.33;
                break;
            case 0: // Players
                // Can't eat self if it's not time to recombine yet
                if (check.owner == cell.owner) {
                    if ((cell.recombineTicks > 0) || (check.recombineTicks > 0)) {
                        continue;
                    }

                    multiplier = 1.00;
                }

                // Can't eat team members
                if (this.gameMode.haveTeams) {
                    if (!check.owner) { // Error check
                        continue;
                    }

                    if ((check.owner != cell.owner) && (check.owner.getTeam() == cell.owner.getTeam())) {
                        continue;
                    }
                }
                break;
            default:
                break;
        }

        // Make sure the cell is big enough to be eaten.
        if ((check.mass * multiplier) > cell.mass) {
            continue;
        }

        // Eating range
        var xs = Math.pow(check.position.x - cell.position.x, 2);
        var ys = Math.pow(check.position.y - cell.position.y, 2);
        var dist = Math.sqrt( xs + ys );

        var eatingRange = cell.getSize() - check.getEatingRange(); // Eating range = radius of eating cell + 40% of the radius of the cell being eaten
        if (dist > eatingRange) {
            // Not in eating range
            continue;
        }

        // Add to list of cells nearby
        list.push(check);

        // Something is about to eat this cell; no need to check for other collisions with it
        check.inRange = true;
    }
    return list;
};

GameServer.prototype.getNearestVirus = function(cell) {
    // More like getNearbyVirus
    var virus = null;
    var r = 100; // Checking radius

    var topY = cell.position.y - r;
    var bottomY = cell.position.y + r;

    var leftX = cell.position.x - r;
    var rightX = cell.position.x + r;

    // Loop through all viruses on the map. There is probably a more efficient way of doing this but whatever
    var len = this.nodesVirus.length;
    for (var i = 0;i < len;i++) {
        var check = this.nodesVirus[i];

        if (typeof check === 'undefined') {
            continue;
        }

        if (!check.collisionCheck(bottomY,topY,rightX,leftX)) {
            continue;
        }

        // Add to list of cells nearby
        virus = check;
    }
    return virus;
};

GameServer.prototype.updateCells = function() {
    // Loop through all player cells
    var massDecay = 1 - (this.config.playerMassDecayRate * this.gameMode.decayMod);
    for (var i = 0; i < this.nodesPlayer.length; i++) {
        var cell = this.nodesPlayer[i];

        if (!cell) {
            continue;
        }

        if (cell.disconnect > -1) {
            // Player has disconnected... remove it when the timer hits -1
            cell.disconnect--;
            if (cell.disconnect == -1) {
                this.removeNode(cell);
                continue;
            }
        } else if (cell.recombineTicks > 0) {
            // Recombining
            cell.recombineTicks--;
        }

        // Mass decay
        if (cell.mass >= this.config.playerMinMassDecay) {
            cell.mass *= massDecay;
        }
    }
};

GameServer.prototype.loadConfig = function(confile) {
    try {
        // Load the contents of the config file
        var load = ini.parse(fs.readFileSync(confile, 'utf-8'));

        // Replace all the default config's values with the loaded config's values
        for (var obj in load) {
            this.config[obj] = load[obj];
        }
    } catch (err) {
        // No config
        console.log("[Game:"+this.realmID+"] Config not found... Generating new config");

        // Create a new config
        fs.writeFileSync(confile, ini.stringify(this.config));
    }
};

GameServer.prototype.switchSpectator = function(player) {
    if (this.gameMode.specByLeaderboard) {
        player.spectatedPlayer++;
        if (player.spectatedPlayer == this.leaderboard.length) {
            player.spectatedPlayer = 0;
        }
    } else {
        // Find next non-spectator with cells in the client list
        var oldPlayer = player.spectatedPlayer + 1;
        var count = 0;
        while (player.spectatedPlayer != oldPlayer && count != this.clients.length) {
            if (oldPlayer == this.clients.length) {
                oldPlayer = 0;
                continue;
            }
            
            if (!this.clients[oldPlayer]) {
                // Break out of loop in case client tries to spectate an undefined player
                player.spectatedPlayer = -1;
                break;
            }
            
            if (this.clients[oldPlayer].playerTracker.cells.length > 0) {
                break;
            }
            
            oldPlayer++;
            count++;
        }
        if (count == this.clients.length) {
            player.spectatedPlayer = -1;
        } else {
            player.spectatedPlayer = oldPlayer;
        }
    }
};

// Custom prototype functions
WebSocket.prototype.sendPacket = function(packet) {
    // Send only if the buffer is empty
    if (this.readyState == WebSocket.OPEN && (this._socket.bufferSize == 0) && packet.build) {
        try {
            this.send(packet.build(), {binary: true});
        } catch (e) {
            console.log("[Error] "+e);
            // Remove socket
            this.emit('close');
            this.removeAllListeners();
        }
    } else if (!packet.build) {
        // Do nothing
        //console.log("[Warning] There was an error sending the packet!");
    } else {
        //console.log("[Warning] There was an error sending the packet to "+this.playerTracker.name);
        // Remove socket
        this.emit('close');
        this.removeAllListeners();
    }
};

