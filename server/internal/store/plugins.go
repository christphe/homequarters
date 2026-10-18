package store

import (
	"context"
	"time"
)

// PluginFlags returns the plugins an administrator enabled or disabled, by name.
func (s *Store) PluginFlags(ctx context.Context, officeID int64) (map[string]bool, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT name, enabled FROM plugins WHERE office_id=?`, officeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		var on bool
		if err := rows.Scan(&n, &on); err != nil {
			return nil, err
		}
		out[n] = on
	}
	return out, rows.Err()
}

func (s *Store) SetPluginEnabled(ctx context.Context, officeID int64, name string, on bool) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO plugins(office_id,name,enabled,updated_at) VALUES (?,?,?,?)
ON CONFLICT(office_id,name) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`, officeID, name, on, time.Now().Unix())
	return err
}

// PluginKV returns a plugin's stored pairs (bounded by the plugin runtime).
func (s *Store) PluginKV(ctx context.Context, officeID int64, plugin string) (map[string]string, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT key, value FROM plugin_kv WHERE office_id=? AND plugin=?`, officeID, plugin)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (s *Store) PutPluginKV(ctx context.Context, officeID int64, plugin, key, value string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO plugin_kv(office_id,plugin,key,value) VALUES (?,?,?,?)
ON CONFLICT(office_id,plugin,key) DO UPDATE SET value=excluded.value`, officeID, plugin, key, value)
	return err
}

func (s *Store) DeletePluginKV(ctx context.Context, officeID int64, plugin, key string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM plugin_kv WHERE office_id=? AND plugin=? AND key=?`, officeID, plugin, key)
	return err
}
