//! WHERE builder (mirrors `src/search/filter-compiler.ts`).

use super::types::SearchOptions;

pub struct FilterClause {
    pub conditions: Vec<String>,
    pub params: Vec<String>,
    pub use_or: bool,
    pub always_and: Vec<String>,
}

fn from_pattern(p: &str) -> String {
    format!("%{}%", p.to_lowercase())
}

pub fn build_filter_clause(opts: &SearchOptions, include_fts: bool) -> FilterClause {
    let mut conditions = Vec::new();
    let mut params = Vec::new();

    if include_fts {
        conditions.push("messages_fts MATCH ?".to_string());
    }

    if let Some(ref a) = opts.from_address {
        let p = from_pattern(a);
        let cond = "(m.from_address LIKE ? OR m.from_name LIKE ?)";
        conditions.push(if opts.filter_or {
            format!("({cond})")
        } else {
            cond.to_string()
        });
        params.push(p.clone());
        params.push(p);
    }

    if let Some(ref a) = opts.to_address {
        let p = from_pattern(a);
        let cond = "(EXISTS (SELECT 1 FROM json_each(m.to_addresses) j WHERE LOWER(j.value) LIKE LOWER(?)) OR EXISTS (SELECT 1 FROM json_each(m.cc_addresses) j WHERE LOWER(j.value) LIKE LOWER(?)))";
        conditions.push(if opts.filter_or {
            format!("({cond})")
        } else {
            cond.to_string()
        });
        params.push(p.clone());
        params.push(p);
    }

    if let Some(ref s) = opts.subject {
        let p = from_pattern(s);
        let cond = "m.subject LIKE ?";
        conditions.push(if opts.filter_or {
            format!("({cond})")
        } else {
            cond.to_string()
        });
        params.push(p);
    }

    if let Some(ref d) = opts.after_date {
        let cond = "m.date >= ?";
        conditions.push(if opts.filter_or {
            format!("({cond})")
        } else {
            cond.to_string()
        });
        params.push(d.clone());
    }

    if let Some(ref d) = opts.before_date {
        let cond = "m.date <= ?";
        conditions.push(if opts.filter_or {
            format!("({cond})")
        } else {
            cond.to_string()
        });
        let bound = if d.len() == 10 {
            format!("{d}T23:59:59.999Z")
        } else {
            d.clone()
        };
        params.push(bound);
    }

    let mut always_and = Vec::new();
    if !opts.include_noise {
        always_and.push("m.is_noise = 0".to_string());
    }

    FilterClause {
        conditions,
        params,
        use_or: opts.filter_or,
        always_and,
    }
}

pub fn build_where_sql(clause: &FilterClause) -> String {
    if clause.conditions.is_empty() && clause.always_and.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    if !clause.conditions.is_empty() {
        let join = if clause.use_or { " OR " } else { " AND " };
        let main = clause.conditions.join(join);
        if clause.use_or && !clause.always_and.is_empty() {
            parts.push(format!("({main})"));
        } else {
            parts.push(main);
        }
    }
    parts.extend(clause.always_and.clone());
    parts.join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_only_minimal() {
        let opts = SearchOptions::default();
        let c = build_filter_clause(&opts, true);
        assert_eq!(c.conditions.len(), 1);
        assert!(c.conditions[0].contains("MATCH"));
        assert!(c.params.is_empty());
    }

    #[test]
    fn from_adds_like_params() {
        let opts = SearchOptions {
            from_address: Some("alice@x.com".into()),
            ..Default::default()
        };
        let c = build_filter_clause(&opts, false);
        assert!(c.conditions.iter().any(|s| s.contains("from_address")));
        assert_eq!(c.params.len(), 2);
        assert!(c.params[0].contains("alice"));
    }

    #[test]
    fn before_date_extends_end_of_day() {
        let opts = SearchOptions {
            before_date: Some("2024-06-01".into()),
            ..Default::default()
        };
        let c = build_filter_clause(&opts, false);
        assert!(c.params.iter().any(|p| p.contains("T23:59:59")));
    }

    #[test]
    fn build_where_and_vs_or() {
        let mut clause = FilterClause {
            conditions: vec!["a = 1".into(), "b = 2".into()],
            params: vec![],
            use_or: false,
            always_and: vec!["c = 3".into()],
        };
        assert_eq!(build_where_sql(&clause), "a = 1 AND b = 2 AND c = 3");
        clause.use_or = true;
        let w = build_where_sql(&clause);
        assert!(w.contains("(a = 1 OR b = 2)"));
        assert!(w.contains("AND c = 3"));
    }

    #[test]
    fn include_noise_skips_noise_clause() {
        let opts = SearchOptions {
            include_noise: true,
            ..Default::default()
        };
        let c = build_filter_clause(&opts, false);
        assert!(c.always_and.is_empty());
    }
}
