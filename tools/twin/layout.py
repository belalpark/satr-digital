"""Construction data for the office digital twin (no Blender imports).

Coordinates are "plan px": the reference plan the room polygons in
data/office.json use (1309 x 1201, x to the right, y down). SCALE converts
them to metres. Walls, doors, furniture and lights below were traced from the
approved furniture layout; materials follow the field photos (white desks,
black/white mesh chairs with blue seats, blue-grey carpet in private offices,
grey carpet in meeting rooms, oak-look floors in shared areas, angular
reception counter with an oak band and LED under-glow, oak bleachers,
dark slate lounge sofas).
"""

SCALE = 32.0          # plan px per metre
WALL_H = 1.40         # dollhouse cut height (m)
SLAB = 0.32           # floor slab thickness shown as the model base (m)

# Exterior wall centre line, clockwise.
OUTLINE = [(162, 110), (252, 110), (252, 40), (492, 40), (492, 102), (1118, 102),
           (1118, 1043), (1031, 1043), (1031, 1115), (800, 1115), (800, 1043), (162, 1043)]

# Low architectural fins outside the east and west facades (x0, y0, x1, y1).
FINS = [(92, 225, 162, 520), (92, 628, 162, 940), (1118, 225, 1196, 520), (1118, 628, 1196, 940)]

# Interior walls: (kind, (x1, y1), (x2, y2), [door spans as (from, to) px measured from the first point]).
# kinds: glass = framed glass partition, solid = plastered wall, core = concrete core wall.
WALLS = [
    # north band
    ('glass', (162, 245), (530, 245), [(181, 211)]),            # CEO front, door
    ('solid', (530, 102), (530, 245), []),                      # CEO / marketing
    ('glass', (530, 245), (867, 245), [(60, 92)]),              # marketing + data analysis front
    ('solid', (867, 102), (867, 245), []),                      # secretary area west
    ('solid', (930, 102), (930, 243), []),                      # secretary / meeting room
    ('glass', (867, 243), (930, 243), [(15, 43)]),              # secretary front
    ('glass', (930, 242), (1118, 242), [(10, 40)]),             # medium meeting room front
    # east wing
    ('glass', (995, 242), (995, 825), [(58, 88), (198, 228), (258, 288), (538, 568)]),
    ('solid', (995, 376), (1118, 376), []),
    ('solid', (995, 481), (1118, 481), []),
    ('solid', (995, 597), (1118, 597), []),
    ('glass', (995, 825), (1118, 825), []),
    # inner ring, north row
    ('glass', (359, 312), (938, 312), [(96, 121), (201, 229), (244, 272), (421, 449), (546, 574)]),
    ('glass', (359, 312), (359, 423), []),
    ('glass', (481, 312), (481, 423), []),
    ('glass', (597, 312), (597, 423), []),
    ('glass', (700, 312), (700, 423), []),
    ('glass', (815, 312), (815, 423), []),
    ('glass', (938, 312), (938, 423), []),
    # meeting room, core, lobby, toilets
    ('solid', (359, 423), (500, 423), []),                      # meeting room screen wall
    ('glass', (359, 423), (359, 722), [(9, 39), (257, 287)]),   # meeting room corridor glass, two doors
    ('core', (500, 423), (690, 423), []),
    ('core', (500, 423), (500, 722), []),
    ('core', (690, 423), (690, 722), []),
    ('core', (500, 722), (690, 722), []),
    ('glass', (690, 423), (768, 423), [(22, 56)]),              # lobby north doors
    ('glass', (690, 735), (768, 735), [(22, 56)]),              # lobby south doors
    ('core', (690, 722), (690, 735), []),
    ('solid', (768, 423), (938, 423), []),
    ('solid', (768, 423), (768, 735), []),
    ('solid', (768, 735), (938, 735), []),
    ('solid', (938, 423), (938, 735), [(32, 64), (232, 264)]),  # toilets doors
    ('solid', (768, 580), (938, 580), []),
    ('solid', (359, 722), (500, 722), []),                      # meeting room / inner office 4
    # south row of the inner ring
    ('glass', (359, 722), (359, 822), [(20, 48)]),
    ('solid', (503, 722), (503, 822), []),
    ('solid', (603, 722), (603, 822), []),
    ('solid', (666, 722), (666, 822), []),
    ('glass', (359, 822), (503, 822), []),
    ('solid', (503, 822), (666, 822), [(70, 98), (128, 156)]),
    # west wing
    ('glass', (303, 245), (303, 888), [(210, 240), (355, 383), (417, 445), (533, 561)]),
    ('glass', (162, 587), (303, 587), []),
    ('glass', (162, 655), (303, 655), []),
    ('glass', (162, 772), (303, 772), []),
    # south band
    ('glass', (162, 888), (594, 888), [(198, 228)]),
    ('glass', (594, 888), (766, 888), [(6, 36)]),
    ('glass', (594, 888), (594, 1043), []),
    ('solid', (766, 888), (766, 1043), []),
]

# Floors that are not rooms in office.json (material zones).
EXTRA_FLOORS = {
    'sec-area': ('carpet_grey', [(867, 102), (930, 102), (930, 243), (867, 243)]),
}

# Floor material per room id (others: by kind).
FLOOR_BY_ROOM = {
    'meeting-large': 'carpet_grey', 'meeting-medium': 'carpet_grey',
    'wc-women': 'tile', 'wc-men': 'tile', 'core': 'stone',
    'store': 'stone', 'data-center': 'stone',
    'entrance': 'stone_light', 'reception': None, 'bleachers': None, 'lounge': None,
    'hr-pmo-ops': 'carpet_grey', 'research': 'carpet_grey', 'data-analysis': 'carpet_grey',
    'marketing': 'carpet_grey', 'field-qc': 'carpet_grey', 'finance': 'carpet_grey',
    'inner-1': 'carpet_grey', 'women-area': 'wood',
}
FLOOR_BY_KIND = {'office': 'carpet_blue', 'meeting': 'carpet_grey', 'open': 'carpet_grey',
                 'service': 'stone', 'social': None, 'circulation': None}

# Lounge platform (raised oak deck the sofas sit on).
PLATFORM = [(997, 828), (1116, 828), (1116, 1041), (965, 1041), (965, 912), (997, 862)]

# ---------------------------------------------------------------- furniture
# rot: direction the item faces in plan terms; 0 = faces down (south, +y),
# 90 = faces east (+x), 180 = faces north, 270 = faces west.

def bench(cx, cy, n, axis, divider=True):
    return {'t': 'bench', 'x': cx, 'y': cy, 'n': n, 'axis': axis, 'divider': divider}


FURNITURE = [
    # CEO
    {'t': 'table_oval', 'x': 366, 'y': 100, 'len': 2.6, 'w': 1.15},
    *[{'t': 'chair_exec', 'x': x, 'y': 66, 'rot': 0} for x in (340, 366, 392)],
    *[{'t': 'chair_exec', 'x': x, 'y': 134, 'rot': 180} for x in (340, 366, 392)],
    {'t': 'chair_exec', 'x': 318, 'y': 100, 'rot': 90},
    {'t': 'chair_exec', 'x': 414, 'y': 100, 'rot': 270},
    {'t': 'sofa', 'x': 252, 'y': 140, 'rot': 0, 'len': 2.2, 'fabric': 'sofa_cream'},
    {'t': 'armchair', 'x': 190, 'y': 176, 'rot': 90, 'fabric': 'sofa_cream'},
    {'t': 'coffee_table', 'x': 252, 'y': 186, 'len': 1.2, 'w': 0.6},
    {'t': 'rug', 'x': 240, 'y': 172, 'len': 3.0, 'w': 2.0, 'mat': 'rug_beige'},
    {'t': 'desk_exec', 'x': 462, 'y': 192, 'rot': 270, 'len': 2.0},
    {'t': 'chair_exec', 'x': 488, 'y': 192, 'rot': 270},
    {'t': 'chair_guest', 'x': 432, 'y': 172, 'rot': 90},
    {'t': 'chair_guest', 'x': 432, 'y': 212, 'rot': 90},
    {'t': 'credenza', 'x': 517, 'y': 150, 'rot': 270, 'len': 1.6},
    {'t': 'plant', 'x': 466, 'y': 70, 's': 1.15},
    {'t': 'plant', 'x': 186, 'y': 222, 's': 1.0},
    # marketing + data analysis
    {'t': 'green_wall', 'x1': 536, 'y1': 128, 'x2': 536, 'y2': 238},
    bench(574, 182, 1, 'x'),
    bench(678, 183, 3, 'y'),
    bench(792, 183, 3, 'y'),
    {'t': 'plant', 'x': 850, 'y': 120, 's': 0.9},
    # secretary area
    {'t': 'plant', 'x': 896, 'y': 132, 's': 1.0},
    {'t': 'credenza', 'x': 898, 'y': 200, 'rot': 90, 'len': 1.2},
    # medium meeting room
    {'t': 'table_meeting', 'x': 1028, 'y': 182, 'len': 3.5, 'w': 1.3, 'axis': 'x', 'top': 'walnut'},
    *[{'t': 'chair_task', 'x': x, 'y': 150, 'rot': 0} for x in (987, 1014, 1042, 1069)],
    *[{'t': 'chair_task', 'x': x, 'y': 214, 'rot': 180} for x in (987, 1014, 1042, 1069)],
    {'t': 'chair_task', 'x': 960, 'y': 182, 'rot': 90},
    {'t': 'chair_task', 'x': 1096, 'y': 182, 'rot': 270},
    {'t': 'plant', 'x': 1106, 'y': 120, 's': 0.9},
    # east wing offices
    {'t': 'desk_exec', 'x': 1098, 'y': 292, 'rot': 90, 'len': 1.8},
    {'t': 'chair_exec', 'x': 1076, 'y': 292, 'rot': 90},
    {'t': 'table_round', 'x': 1040, 'y': 352, 'r': 0.42},
    {'t': 'chair_guest', 'x': 1040, 'y': 330, 'rot': 0},
    {'t': 'chair_guest', 'x': 1040, 'y': 372, 'rot': 180},
    {'t': 'plant', 'x': 1010, 'y': 262, 's': 0.9},
    {'t': 'desk_exec', 'x': 1098, 'y': 428, 'rot': 90, 'len': 1.8},
    {'t': 'chair_exec', 'x': 1076, 'y': 428, 'rot': 90},
    {'t': 'cabinet', 'x': 1030, 'y': 388, 'rot': 0, 'len': 1.2},
    {'t': 'plant', 'x': 1010, 'y': 466, 's': 0.85},
    {'t': 'desk_exec', 'x': 1064, 'y': 538, 'rot': 0, 'len': 1.8},
    {'t': 'chair_exec', 'x': 1064, 'y': 514, 'rot': 0},
    {'t': 'cabinet', 'x': 1104, 'y': 572, 'rot': 270, 'len': 1.0},
    {'t': 'plant', 'x': 1010, 'y': 582, 's': 0.85},
    bench(1046, 636, 2, 'x'),
    bench(1060, 756, 3, 'x'),
    {'t': 'plant', 'x': 1106, 'y': 690, 's': 0.9},
    # lounge (dark slate modular sofas)
    {'t': 'platform'},
    {'t': 'sofa', 'x': 1062, 'y': 838, 'rot': 0, 'len': 2.4, 'fabric': 'sofa_slate'},
    {'t': 'sofa', 'x': 1104, 'y': 872, 'rot': 270, 'len': 1.9, 'fabric': 'sofa_slate'},
    {'t': 'coffee_table', 'x': 1056, 'y': 880, 'len': 1.1, 'w': 0.6},
    {'t': 'rug', 'x': 1060, 'y': 878, 'len': 2.8, 'w': 2.0, 'mat': 'rug_grey'},
    {'t': 'sofa', 'x': 1066, 'y': 930, 'rot': 0, 'len': 2.4, 'fabric': 'sofa_slate'},
    {'t': 'sofa', 'x': 1104, 'y': 975, 'rot': 270, 'len': 2.4, 'fabric': 'sofa_slate'},
    {'t': 'sofa', 'x': 1062, 'y': 1024, 'rot': 180, 'len': 2.2, 'fabric': 'sofa_slate'},
    {'t': 'coffee_table', 'x': 1058, 'y': 976, 'len': 1.1, 'w': 0.65},
    {'t': 'rug', 'x': 1060, 'y': 976, 'len': 2.8, 'w': 2.4, 'mat': 'rug_grey'},
    {'t': 'pouf', 'x': 1012, 'y': 960}, {'t': 'pouf', 'x': 1012, 'y': 990},
    {'t': 'floor_lamp', 'x': 1093, 'y': 906},
    {'t': 'floor_lamp', 'x': 984, 'y': 1026},
    {'t': 'plant', 'x': 990, 'y': 1000, 's': 1.2},
    {'t': 'plant', 'x': 1106, 'y': 1032, 's': 0.85},
    # reception
    {'t': 'reception'},
    {'t': 'feature_shelves', 'x1': 788, 'x2': 930, 'y': 743},
    {'t': 'plant', 'x': 912, 'y': 808, 's': 0.55},
    {'t': 'armchair', 'x': 778, 'y': 890, 'rot': 90, 'fabric': 'sofa_cream'},
    {'t': 'side_table', 'x': 800, 'y': 902},
    # bleachers
    {'t': 'bleachers', 'x1': 806, 'y1': 1046, 'x2': 1028, 'y2': 1112, 'stair_x1': 897, 'stair_x2': 931},
    {'t': 'plant', 'x': 818, 'y': 1058, 's': 0.9},
    {'t': 'plant', 'x': 1016, 'y': 1058, 's': 0.9},
    {'t': 'pouf', 'x': 860, 'y': 1020}, {'t': 'pouf', 'x': 950, 'y': 1018},
    # inner ring north row
    bench(425, 370, 2, 'y'),
    {'t': 'desk_exec', 'x': 516, 'y': 362, 'rot': 180, 'len': 1.8},
    {'t': 'chair_exec', 'x': 516, 'y': 388, 'rot': 180},
    {'t': 'cabinet', 'x': 556, 'y': 414, 'rot': 180, 'len': 1.0},
    {'t': 'plant', 'x': 496, 'y': 330, 's': 0.85},
    {'t': 'desk_exec', 'x': 664, 'y': 362, 'rot': 180, 'len': 1.8},
    {'t': 'chair_exec', 'x': 664, 'y': 388, 'rot': 180},
    {'t': 'cabinet', 'x': 616, 'y': 414, 'rot': 180, 'len': 1.0},
    {'t': 'plant', 'x': 684, 'y': 330, 's': 0.85},
    {'t': 'sofa', 'x': 748, 'y': 410, 'rot': 180, 'len': 2.0, 'fabric': 'sofa_blue'},
    {'t': 'coffee_table', 'x': 748, 'y': 380, 'len': 0.9, 'w': 0.5},
    {'t': 'armchair', 'x': 718, 'y': 350, 'rot': 90, 'fabric': 'sofa_blue'},
    {'t': 'plant', 'x': 796, 'y': 334, 's': 1.1},
    bench(875, 370, 2, 'y'),
    # meeting room (16 seats, white modular table, white-shell chairs with blue seats)
    {'t': 'table_meeting', 'x': 430, 'y': 590, 'len': 6.2, 'w': 1.3, 'axis': 'y', 'top': 'desk_white', 'modules': 2},
    *[{'t': 'chair_task', 'x': 397, 'y': y, 'rot': 90} for y in (506, 530, 554, 578, 602, 626, 650, 674)],
    *[{'t': 'chair_task', 'x': 463, 'y': y, 'rot': 270} for y in (506, 530, 554, 578, 602, 626, 650, 674)],
    {'t': 'tv_wall', 'x1': 372, 'x2': 488, 'y': 427, 'face': 0},
    {'t': 'whiteboard', 'x': 478, 'y': 708, 'rot': 180},
    {'t': 'plant', 'x': 372, 'y': 710, 's': 0.8},
    # inner ring south row
    bench(434, 770, 1, 'y'),
    {'t': 'shelving', 'x': 553, 'y': 732, 'rot': 0, 'len': 2.6},
    {'t': 'shelving', 'x': 513, 'y': 778, 'rot': 90, 'len': 2.0},
    {'t': 'rack', 'x': 634, 'y': 738, 'rot': 0},
    # toilets
    {'t': 'wc_block'},
    # core
    {'t': 'core'},
    # west wing
    bench(237, 313, 3, 'x'),
    bench(237, 419, 3, 'x'),
    bench(253, 534, 2, 'x'),
    {'t': 'plant', 'x': 176, 'y': 258, 's': 0.85},
    {'t': 'desk_exec', 'x': 230, 'y': 604, 'rot': 180, 'len': 1.7},
    {'t': 'chair_exec', 'x': 230, 'y': 628, 'rot': 180},
    {'t': 'plant', 'x': 287, 'y': 642, 's': 0.75},
    {'t': 'desk_exec', 'x': 205, 'y': 708, 'rot': 180, 'len': 1.7},
    {'t': 'chair_exec', 'x': 205, 'y': 734, 'rot': 180},
    {'t': 'cabinet', 'x': 292, 'y': 742, 'rot': 270, 'len': 1.1},
    {'t': 'plant', 'x': 176, 'y': 670, 's': 0.8},
    {'t': 'desk_exec', 'x': 180, 'y': 846, 'rot': 270, 'len': 1.6},
    {'t': 'chair_exec', 'x': 204, 'y': 846, 'rot': 270},
    {'t': 'table_round', 'x': 266, 'y': 846, 'r': 0.4},
    {'t': 'chair_guest', 'x': 266, 'y': 824, 'rot': 0},
    {'t': 'chair_guest', 'x': 266, 'y': 868, 'rot': 180},
    {'t': 'plant', 'x': 178, 'y': 786, 's': 0.8},
    # HR / PMO / operations
    bench(267, 962, 4, 'x'),
    bench(490, 962, 4, 'x'),
    {'t': 'plant', 'x': 176, 'y': 902, 's': 0.85},
    {'t': 'plant', 'x': 178, 'y': 1028, 's': 0.9},
    {'t': 'plant', 'x': 580, 'y': 1024, 's': 1.0},
    # COO
    {'t': 'desk_exec', 'x': 702, 'y': 1004, 'rot': 270, 'len': 1.8},
    {'t': 'chair_exec', 'x': 726, 'y': 1004, 'rot': 270},
    {'t': 'table_round', 'x': 632, 'y': 982, 'r': 0.42},
    {'t': 'chair_guest', 'x': 632, 'y': 958, 'rot': 0},
    {'t': 'chair_guest', 'x': 632, 'y': 1006, 'rot': 180},
    {'t': 'plant', 'x': 750, 'y': 904, 's': 0.9},
    {'t': 'credenza', 'x': 680, 'y': 898, 'rot': 0, 'len': 1.8},
]

# Warm ceiling light pools: (x, y) in plan px; plus per-room grids generated by the builder.
EXTRA_LIGHTS = [
    (331, 300), (331, 480), (331, 660), (331, 840),          # west corridor
    (420, 278), (560, 278), (700, 278), (850, 278), (966, 300),  # north corridor
    (966, 480), (966, 660),                                     # east corridor
    (420, 855), (560, 855), (700, 860),                         # south corridor
    (729, 500), (729, 660),                                     # lobby
    (850, 800), (880, 960), (840, 1010), (990, 1010),           # reception / bleachers front
]
