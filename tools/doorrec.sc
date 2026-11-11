// doorrec - tick-by-tick recorder of a redstone door (Carpet / scarpet app)
//
// Install:  <world>/scripts/doorrec.sc, then in game:  /script load doorrec
// Usage:
//   /doorrec box <from> <to>   two opposite corners of the door, mechanism and lever included
//   /doorrec rec <name>        arm the recorder, then toggle the door
//   /doorrec stop              finish the current recording by hand
//
// A recording ends by itself after the box stayed unchanged for global_quiet_limit ticks.
// Output: <world>/scripts/doorrec.data/<name>.json
//
// File layout:
//   size     [sx, sy, sz] of the box
//   origin   world coordinates of the box minimum corner
//   viewer   where the player stood when arming (position relative to origin, yaw, pitch, facing)
//   palette  list of block states: {name, props?, nbt?}  (nbt only for moving_piston)
//   frames   list of {t, changes}; changes is a flat list [index, state, index, state, ...]
//            index = x + sx * (z + sz * y), coordinates relative to origin
//            frame t = 0 holds the full initial state of the box

__config() -> {
    'scope' -> 'global',
    'commands' -> {
        'box <from> <to>' -> 'cmd_box',
        'rec <name>' -> 'cmd_rec',
        'stop' -> 'cmd_stop'
    },
    'arguments' -> {
        'from' -> {'type' -> 'pos'},
        'to' -> {'type' -> 'pos'},
        'name' -> {'type' -> 'term', 'suggest' -> ['close', 'open']}
    }
};

global_quiet_limit = 60;
global_max_ticks = 6000;
global_max_volume = 30000;

global_box_set = false;
global_recording = false;

cmd_box(from, to) -> (
    p = player();
    if(global_recording, (print(p, 'doorrec: a recording is running, /doorrec stop first'); return()));
    global_min = [min(from:0, to:0), min(from:1, to:1), min(from:2, to:2)];
    global_max = [max(from:0, to:0), max(from:1, to:1), max(from:2, to:2)];
    global_size = [
        global_max:0 - global_min:0 + 1,
        global_max:1 - global_min:1 + 1,
        global_max:2 - global_min:2 + 1
    ];
    blocks = global_size:0 * global_size:1 * global_size:2;
    if(blocks > global_max_volume,
        (print(p, str('doorrec: box is too big (%d blocks, limit %d)', blocks, global_max_volume)); return())
    );
    global_box_set = true;
    print(p, str('doorrec: box %d x %d x %d (%d blocks)', global_size:0, global_size:1, global_size:2, blocks))
);

// Returns the palette index of the state of block b, adding it to the palette when new.
state_id(b) -> (
    name = str(b);
    props = block_state(b);
    nbt = if(name == 'moving_piston', block_data(b), null);
    key = name + '|' + str(props) + '|' + str(nbt);
    if(!has(global_index, key),
        entry = {'name' -> name};
        if(length(props) > 0, entry:'props' = props);
        if(nbt != null, entry:'nbt' = parse_nbt(nbt));
        global_index:key = length(global_palette);
        global_palette += entry
    );
    global_index:key
);

// Scans the box and returns the flat list of changes since the previous scan.
scan_box() -> (
    changes = [];
    volume(global_min, global_max,
        id = state_id(_);
        i = (_x - global_min:0) + global_size:0 * ((_z - global_min:2) + global_size:2 * (_y - global_min:1));
        if(!has(global_last, i) || global_last:i != id,
            global_last:i = id;
            changes += i;
            changes += id
        )
    );
    changes
);

cmd_rec(name) -> (
    p = player();
    if(!global_box_set, (print(p, 'doorrec: set the box first: /doorrec box <from> <to>'); return()));
    if(global_recording, (print(p, 'doorrec: already recording, /doorrec stop first'); return()));
    global_name = name;
    global_player = p;
    global_palette = [];
    global_index = {};
    global_last = {};
    global_frames = [];
    global_tick = 0;
    global_started = false;
    global_quiet = 0;
    pp = pos(p);
    global_viewer = {
        'pos' -> [pp:0 - global_min:0, pp:1 - global_min:1, pp:2 - global_min:2],
        'yaw' -> query(p, 'yaw'),
        'pitch' -> query(p, 'pitch'),
        'facing' -> query(p, 'facing')
    };
    first = scan_box();
    global_frames += {'t' -> 0, 'changes' -> first};
    global_recording = true;
    print(p, str('doorrec: armed "%s" - toggle the door now', name))
);

finish() -> (
    global_recording = false;
    data = {
        'format' -> 1,
        'name' -> global_name,
        'size' -> global_size,
        'origin' -> global_min,
        'viewer' -> global_viewer,
        'ticks' -> global_tick,
        'palette' -> global_palette,
        'frames' -> global_frames
    };
    delete_file(global_name, 'json');
    ok = write_file(global_name, 'json', data);
    print(global_player, str(
        'doorrec: %s "%s" - %d ticks, %d frames with changes, %d states',
        if(ok, 'saved', 'FAILED to save'), global_name, global_tick, length(global_frames), length(global_palette)
    ))
);

cmd_stop() -> (
    if(global_recording, finish(), print(player(), 'doorrec: nothing is being recorded'))
);

__on_tick() -> (
    if(global_recording,
        global_tick += 1;
        changes = scan_box();
        if(length(changes) > 0,
            (
                global_frames += {'t' -> global_tick, 'changes' -> changes};
                global_started = true;
                global_quiet = 0
            ),
            if(global_started, global_quiet += 1)
        );
        if((global_started && global_quiet >= global_quiet_limit) || global_tick >= global_max_ticks,
            finish()
        )
    )
);
