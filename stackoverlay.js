const Extension = imports.misc.extensionUtils.extensions['paperwm@hedning:matrix.org']
const Tiling = Extension.imports.tiling;
const Clutter = imports.gi.Clutter;
const Tweener = imports.ui.tweener;
const Lang = imports.lang;
const Main = imports.ui.main;
const Shell = imports.gi.Shell;
const Meta = imports.gi.Meta;
const utils = Extension.imports.utils;
const debug = utils.debug;
const Minimap = Extension.imports.minimap;

/*
  The stack overlay decorates the top stacked window with its icon and
  captures mouse input such that a mouse click only _activates_ the
  window. A very limited portion of the window is visible and due to
  the animation the button-up event will be triggered at an
  unpredictable position

  See #10
*/

/*
  Parent of the overlay?

  Most natural parent is the window actor, but then the overlay
  becomes visible in the clones too.

  Since the stacked windows doesn't really move it's not a big problem
  that the overlay doesn't track the window. The main challenge with
  using a different parent becomes controlling the "z-index".

  If I understand clutter correctly that can only be done by managing
  the order of the scene graph nodes. Descendants of node A will thus
  always be drawn in the same plane compared to a non-descendants.

  The overlay thus have to be parented to `global.window_group`. One
  would think that was ok, but unfortunately mutter keeps syncing the
  window_group with the window stacking and in the process destroy the
  stacking of any non-window actors.

  Adding a "clutter restack" to the `MetaScreen` `restacked` signal
  seems keep the stacking in sync (without entering into infinite
  restack loops)
*/

function createAppIcon(metaWindow, size) {
    let tracker = Shell.WindowTracker.get_default();
    let app = tracker.get_window_app(metaWindow);
    let appIcon = app ? app.create_icon_texture(size)
        : new St.Icon({ icon_name: 'icon-missing',
                        icon_size: size });
    appIcon.x_expand = appIcon.y_expand = true;
    appIcon.x_align = appIcon.y_align = Clutter.ActorAlign.END;

    return appIcon;
}

/**
 */
class ClickOverlay {
    constructor(monitor) {
        this.monitor = monitor;
        this.left = new StackOverlay(Meta.MotionDirection.LEFT, monitor);
        this.right = new StackOverlay(Meta.MotionDirection.RIGHT, monitor);

        let enterMonitor = new Clutter.Actor({reactive: true});
        this.enterMonitor = enterMonitor;
        enterMonitor.set_position(monitor.x, monitor.y);

        Main.uiGroup.add_actor(enterMonitor);

        this.enterSignal = enterMonitor.connect(
            'enter-event', () => {
                this.reset();
                let space = Tiling.spaces.monitors.get(this.monitor);
                space.workspace.activate(global.get_current_time());
                return Clutter.EVENT_STOP;
            }
        );
    }

    activate() {
        let monitor = this.monitor;
        this.enterMonitor.set_position(monitor.x, monitor.y);
        this.enterMonitor.set_size(monitor.width, monitor.height);
    }

    reset() {
        this.left.setTarget(null);
        this.right.setTarget(null);
        this.enterMonitor.set_size(0, 0);
    }

    destroy() {
        for (let overlay of [this.left, this.right]) {
            let actor = overlay.overlay;
            actor.disconnect(overlay.pressId);
            actor.disconnect(overlay.releaseId);
            actor.destroy();
        }
        this.enterMonitor.disconnect(this.enterSignal);
        this.enterMonitor.destroy();
    }
}

var StackOverlay = new Lang.Class({
    Name: 'Stackoverlay',

    _init: function(direction, monitor, showIcon) {
        this.showIcon = showIcon;

        this._direction = direction;

        let overlay = new Clutter.Actor({ reactive: true
                                          , name: "stack-overlay" });

        this.monitor = monitor;

        let panelBox = Main.layoutManager.panelBox;

        overlay.y = monitor.y + panelBox.height + Tiling.margin_tb;
        overlay.height = this.monitor.height - panelBox.height - Tiling.margin_tb;
        overlay.width = Tiling.stack_margin;

        overlay.hide();

        this.pressId = overlay.connect('button-press-event', () => {
            return true;
        });
        this.releaseId = overlay.connect('button-release-event', () => {
            // this.fadeOut();
            Main.activateWindow(this.target);
            return true;
        });

        global.window_group.add_child(overlay);
        Main.layoutManager._trackActor(overlay)

        this.overlay = overlay;
    },
    updateIcon: function() {
        if (this.icon) {
            this.icon.destroy();
            this.icon = null;
        }

        let iconMarginX = 2;
        let iconSize = margin_lr;
        let icon = createAppIcon(this.target, iconSize);
        this.icon = icon;

        let actor = this.target.get_compositor_private();

        if (actor.x <= Tiling.stack_margin) {
            icon.x = iconMarginX;
        } else {
            icon.x = this.overlay.width - iconMarginX - iconSize; 
        }

        let [dx, dy] = Minimap.calcOffset(this.target);
        icon.y = actor.y + dy + 4 - this.overlay.y;

        this.overlay.add_child(icon);
    },
    setTarget: function(metaWindow, direction) {
        this.target = metaWindow;

        let bail = () => {
            this.target = null;
            this.overlay.hide();
            return false;
        }

        if (!metaWindow) {
            // No target. Eg. if we're at the left- or right-most window
            return bail();
        }

        let overlay = this.overlay;
        let actor = metaWindow.get_compositor_private();
        let frame = metaWindow.get_frame_rect();
        let space = Tiling.spaces.spaceOfWindow(metaWindow);

        overlay.y = this.monitor.y + Main.layoutManager.panelBox.height + Tiling.margin_tb;

        // Note: Atm. this can be called when the windows are moving. Therefore
        //       we must use destinationX and we might occationally get wrong y
        //       positions (icon) (since we don't track the y destination)
        //       We also assume window widths are are unchanging.
        if (this._direction === Meta.MotionDirection.LEFT) {
            let neighbour = space[space.indexOf(metaWindow) + 1]
            if (!neighbour)
                return bail(); // Should normally have a neighbour. Bail!
 
            let neighbourX = neighbour.destinationX;
            if (neighbourX === undefined)
                neighbourX = neighbour.get_frame_rect().x;

            overlay.x = this.monitor.x;
            overlay.width = Math.max(0, neighbourX - Tiling.window_gap);
        } else {
            let neighbour = space[space.indexOf(metaWindow) - 1]
            if (!neighbour)
                return bail(); // Should normally have a neighbour. Bail!

            let neighbourFrame = neighbour.get_frame_rect();
            let neighbourX = neighbour.destinationX;
            if (neighbourX === undefined)
                neighbourX = neighbourFrame.x;

            overlay.x = neighbourX + neighbourFrame.width + Tiling.window_gap;
            overlay.width = Math.max(0, this.monitor.width - overlay.x);
        }

        if (this.showIcon) {
            this.updateIcon();
        }

        global.window_group.set_child_above_sibling(overlay, actor);

        // Tweener.addTween(this.overlay, { opacity: 255, time: 0.25 });
        overlay.show();
        return true;
    },
    fadeOut: function() {
        Tweener.addTween(this.overlay, { opacity: 0, time: 0.25 });
    }
});

function reset() {
    leftOverlay.setTarget(null);
    rightOverlay.setTarget(null);
}

var leftOverlay;
var rightOverlay;
function enable() {
    let monitor = Main.layoutManager.primaryMonitor;
    leftOverlay  = new StackOverlay(Meta.MotionDirection.LEFT, monitor);
    rightOverlay = new StackOverlay(Meta.MotionDirection.RIGHT, monitor);
}

function disable() {
    // Disconnect the overlay
    for (let overlay of [leftOverlay, rightOverlay]) {
        let actor = overlay.overlay;
        actor.disconnect(overlay.pressId);
        actor.disconnect(overlay.releaseId);
        actor.destroy();
    }
}
