using System.Drawing;
using System.Windows.Forms;

namespace GameHub.Agent.SessionHost;

/// <summary>
/// Full-screen session UI. It is deliberately simple: show time remaining, and when the
/// session is over show a lock screen. It does not kill processes, wipe data or shut the
/// PC down - the station simply becomes unusable until staff act.
/// </summary>
public sealed class KioskForm : Form
{
    private readonly System.Windows.Forms.Timer _tick = new() { Interval = 1000 };
    private readonly Label _clock = new();
    private readonly Label _title = new();
    private readonly Label _detail = new();
    private readonly Label _station = new();
    private readonly System.Windows.Forms.Timer _poll = new() { Interval = 5000 };

    private AgentSnapshot? _snapshot;
    private bool _locked;
    private Guid? _acknowledgedSessionId;

    public KioskForm(string stationName)
    {
        Text = "GameHub Session";
        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Maximized;
        TopMost = true;
        BackColor = Color.FromArgb(10, 13, 19);
        ForeColor = Color.White;
        KeyPreview = true;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = false;

        _station = new Label
        {
            Text = stationName.ToUpperInvariant(),
            AutoSize = true,
            ForeColor = Color.FromArgb(165, 180, 252),
            Font = new Font("Segoe UI", 12, FontStyle.Bold),
            Location = new Point(48, 40)
        };

        _title = new Label
        {
            Text = "Starting…",
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 34, FontStyle.Bold),
            Dock = DockStyle.Fill
        };

        _clock = new Label
        {
            Text = "--:--",
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.White,
            Font = new Font("Consolas", 96, FontStyle.Bold),
            Dock = DockStyle.Fill
        };

        _detail = new Label
        {
            Text = string.Empty,
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.FromArgb(148, 163, 184),
            Font = new Font("Segoe UI", 15),
            Dock = DockStyle.Fill
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            Padding = new Padding(24)
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 10));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 25));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 25));
        layout.Controls.Add(_station, 0, 0);
        layout.Controls.Add(_title, 0, 1);
        layout.Controls.Add(_clock, 0, 2);
        layout.Controls.Add(_detail, 0, 3);

        Controls.Add(layout);

        _tick.Tick += (_, _) => Render();
        _poll.Tick += (_, _) => RefreshState();

        Shown += (_, _) =>
        {
            RefreshState();
            _tick.Start();
            _poll.Start();
        };

        FormClosing += OnFormClosing;
        KeyDown += OnKeyDown;
    }

    /// <summary>Raised when the desktop should be released to the normal shell.</summary>
    public event EventHandler? SessionAuthorized;

    private void RefreshState()
    {
        var snapshot = PipeClient.Query();
        if (snapshot is null)
        {
            // Service unreachable: keep showing the last known state, but never unlock.
            if (_snapshot is not null)
            {
                _snapshot = _snapshot with { State = _locked ? "RECOVERY" : _snapshot.State };
            }
            Render();
            return;
        }
        _snapshot = snapshot;
        Render();
    }

    private void Render()
    {
        if (_snapshot is null)
        {
            _title.Text = "Connecting to the café server…";
            _clock.Text = "--:--";
            _detail.Text = "If this persists, ask a staff member.";
            return;
        }

        var now = DateTimeOffset.UtcNow;
        var state = _snapshot.State;

        if (state == "AUTHORIZED" && _snapshot.ExpiresAtUtc is { } expiry)
        {
            var remaining = expiry - now;
            if (remaining <= TimeSpan.Zero)
            {
                // Local expiry: lock immediately even if the server has not been heard from.
                Lock("Session time is over");
                return;
            }

            _locked = false;
            _station.Text = $"{_snapshot.CustomerNickname ?? "Player"} · GAMEHUB";
            _title.Text = "TIME REMAINING";
            _clock.Text = $"{(int)remaining.TotalHours:00}:{remaining.Minutes:00}:{remaining.Seconds:00}";
            _clock.ForeColor = remaining.TotalMinutes <= 5 ? Color.FromArgb(251, 191, 36) : Color.White;
            _detail.Text = "Please finish up. Ask staff at the front desk to extend your session.";
            SessionAuthorized?.Invoke(this, EventArgs.Empty);
            return;
        }

        switch (state)
        {
            case "RECOVERY":
                Lock("Reconnecting…");
                _detail.Text = "The café server cannot be reached. Ask staff for help.";
                break;
            case "EXPIRED":
                Lock("Session ended");
                _detail.Text = "Ask staff at the front desk to start a new session.";
                break;
            case "DISABLED":
            case "MAINTENANCE":
                Lock("Station unavailable");
                _detail.Text = "This station is out of service. Please ask staff.";
                break;
            default:
                Lock("Waiting for a session");
                _detail.Text = "Ask staff at the front desk to start your session.";
                break;
        }
    }

    private void Lock(string title)
    {
        _locked = true;
        _title.Text = title.ToUpperInvariant();
        _clock.Text = "00:00";
        _clock.ForeColor = Color.FromArgb(251, 113, 133);

        // Tell the service once per session that the lock is really on screen.
        var sessionId = _snapshot?.SessionId;
        if (_acknowledgedSessionId != sessionId)
        {
            _acknowledgedSessionId = sessionId;
            PipeClient.AcknowledgeRestriction(sessionId);
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // The kiosk cannot be closed by the customer; staff stop it via the service.
        if (e.CloseReason is CloseReason.UserClosing or CloseReason.TaskManagerClosing)
        {
            e.Cancel = true;
        }
    }

    private void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.F4 && e.Alt) e.Handled = true;
        if (e.KeyCode == Keys.Escape) e.Handled = true;
    }
}
