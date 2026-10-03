use shore_common::protocol::operations::{ConversationPage, SegmentSummary};

use super::{App, ConversationEntry};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SegmentRequest {
    Open,
    Earlier,
    Neighbours,
}

pub(crate) struct SegmentView {
    pub summary: SegmentSummary,
    pub previous: Option<SegmentSummary>,
    pub next: Option<SegmentSummary>,
    pub entries: Vec<ConversationEntry>,
    pub next_before: usize,
    pub has_more_before: bool,
    pub live_scroll: usize,
    pub live_auto_scroll: bool,
    pub live_entries: usize,
}

impl App {
    pub(crate) fn visible_entries(&self) -> &[ConversationEntry] {
        self.segment_view
            .as_ref()
            .map_or(&self.entries, |view| &view.entries)
    }

    pub(crate) fn show_segment(
        &mut self,
        page: ConversationPage,
        entries: Vec<ConversationEntry>,
    ) -> bool {
        let Some(summary) = page.segment else {
            return false;
        };
        let (live_scroll, live_auto_scroll, live_entries) = self.segment_view.take().map_or(
            (self.scroll_offset, self.auto_scroll, self.entries.len()),
            |view| (view.live_scroll, view.live_auto_scroll, view.live_entries),
        );
        self.segment_view = Some(SegmentView {
            summary,
            previous: page.previous_segment,
            next: page.next_segment,
            entries,
            next_before: page.next_before,
            has_more_before: page.has_more_before,
            live_scroll,
            live_auto_scroll,
            live_entries,
        });
        self.scroll_to_bottom();
        self.history_version = self.history_version.wrapping_add(1);
        true
    }

    pub(crate) fn prepend_segment_page(
        &mut self,
        page: ConversationPage,
        entries: Vec<ConversationEntry>,
    ) {
        let Some(view) = &mut self.segment_view else {
            return;
        };
        if page.segment.as_ref().map(|summary| summary.index) != Some(view.summary.index) {
            return;
        }
        view.next_before = page.next_before;
        view.has_more_before = page.has_more_before;
        if entries.is_empty() {
            return;
        }
        drop(view.entries.splice(0..0, entries));
        self.grew_above_viewport = true;
        self.history_version = self.history_version.wrapping_add(1);
    }

    pub(crate) fn refresh_segment_neighbours(&mut self, page: ConversationPage) {
        let Some(view) = &mut self.segment_view else {
            return;
        };
        let Some(summary) = page
            .segment
            .filter(|summary| summary.index == view.summary.index)
        else {
            return;
        };
        view.summary = summary;
        view.previous = page.previous_segment;
        view.next = page.next_segment;
        self.history_version = self.history_version.wrapping_add(1);
    }

    pub(crate) fn close_segment_view(&mut self) -> bool {
        self.pending_segment_page = None;
        let Some(view) = self.segment_view.take() else {
            return false;
        };
        self.scroll_offset = view.live_scroll;
        self.auto_scroll = view.live_auto_scroll;
        self.history_version = self.history_version.wrapping_add(1);
        true
    }

    pub(crate) fn live_moved_on(&self) -> bool {
        self.segment_view
            .as_ref()
            .is_some_and(|view| self.stream.active || self.entries.len() != view.live_entries)
    }
}

#[cfg(test)]
pub(crate) fn segment_fixture(index: u64, label: Option<&str>) -> SegmentSummary {
    SegmentSummary {
        index,
        first_message_at: Some("2026-09-28T10:00:00+00:00".into()),
        last_message_at: Some("2026-10-01T22:00:00+00:00".into()),
        compacted_at: "2026-10-01T22:05:00+00:00".into(),
        message_count: 2,
        excluded: false,
        label: label.map(str::to_owned),
        note: None,
        memory_before: None,
        memory_after: None,
    }
}

#[cfg(test)]
pub(crate) fn segment_page_fixture(
    index: u64,
    previous: Option<u64>,
    next: Option<u64>,
    has_more_before: bool,
) -> ConversationPage {
    ConversationPage {
        messages: vec![],
        cursor: 10,
        next_before: 10,
        has_more_before,
        total_turns: 1,
        segment: Some(segment_fixture(index, None)),
        previous_segment: previous.map(|earlier| segment_fixture(earlier, None)),
        next_segment: next.map(|later| segment_fixture(later, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(text: &str) -> ConversationEntry {
        ConversationEntry::user(text.into(), vec![], String::new())
    }

    fn texts(entries: &[ConversationEntry]) -> Vec<String> {
        entries
            .iter()
            .filter_map(ConversationEntry::as_turn)
            .map(super::super::Turn::joined_text)
            .collect()
    }

    #[test]
    fn a_segment_view_replaces_what_is_shown_and_restores_the_live_scroll() {
        let mut app = App {
            entries: vec![turn("live")],
            scroll_offset: 7,
            auto_scroll: false,
            ..App::default()
        };
        let version = app.history_version;

        assert!(app.show_segment(
            segment_page_fixture(3, Some(2), None, true),
            vec![turn("old")]
        ));
        assert_eq!(texts(app.visible_entries()), ["old"]);
        assert_eq!((app.scroll_offset, app.auto_scroll), (0, true));
        assert_ne!(app.history_version, version);

        assert!(app.show_segment(
            segment_page_fixture(2, None, Some(3), false),
            vec![turn("older")]
        ));
        assert_eq!(texts(app.visible_entries()), ["older"]);
        let view = app.segment_view.as_ref().unwrap();
        assert_eq!((view.live_scroll, view.live_auto_scroll), (7, false));

        app.pending_segment_page = Some(("late".into(), SegmentRequest::Earlier));
        assert!(app.close_segment_view());
        assert_eq!(texts(app.visible_entries()), ["live"]);
        assert_eq!((app.scroll_offset, app.auto_scroll), (7, false));
        assert!(app.pending_segment_page.is_none());
        assert!(!app.close_segment_view());
    }

    #[test]
    fn a_page_without_a_segment_opens_nothing() {
        let mut app = App::default();
        let mut page = segment_page_fixture(1, None, None, false);
        page.segment = None;
        assert!(!app.show_segment(page, vec![turn("current")]));
        assert!(app.segment_view.is_none());
    }

    #[test]
    fn earlier_pages_prepend_only_into_the_segment_they_came_from() {
        let mut app = App::default();
        assert!(app.show_segment(
            segment_page_fixture(4, None, None, true),
            vec![turn("late")]
        ));
        app.grew_above_viewport = false;

        app.prepend_segment_page(
            segment_page_fixture(5, None, None, false),
            vec![turn("stray")],
        );
        assert_eq!(texts(app.visible_entries()), ["late"]);
        assert!(!app.grew_above_viewport);

        let mut earlier = segment_page_fixture(4, None, None, false);
        earlier.next_before = 2;
        app.prepend_segment_page(earlier, vec![turn("early")]);
        assert_eq!(texts(app.visible_entries()), ["early", "late"]);
        let view = app.segment_view.as_ref().unwrap();
        assert_eq!((view.next_before, view.has_more_before), (2, false));
        assert!(app.grew_above_viewport);

        let mut live = App::default();
        live.prepend_segment_page(segment_page_fixture(4, None, None, false), vec![turn("x")]);
        assert!(live.segment_view.is_none());
    }

    #[test]
    fn a_neighbour_refresh_updates_the_links_but_not_the_messages() {
        let mut app = App::default();
        assert!(app.show_segment(
            segment_page_fixture(4, Some(3), None, false),
            vec![turn("kept")]
        ));
        app.refresh_segment_neighbours(segment_page_fixture(9, None, None, false));
        assert!(app.segment_view.as_ref().unwrap().next.is_none());

        let mut fresh = segment_page_fixture(4, Some(3), Some(5), false);
        fresh.segment = Some(segment_fixture(4, Some("renamed")));
        app.refresh_segment_neighbours(fresh);
        let view = app.segment_view.as_ref().unwrap();
        assert_eq!(view.next.as_ref().map(|next| next.index), Some(5));
        assert_eq!(view.summary.label.as_deref(), Some("renamed"));
        assert_eq!(texts(&view.entries), ["kept"]);
    }

    #[test]
    fn live_activity_is_noticed_while_a_segment_is_open() {
        let mut app = App::default();
        assert!(!app.live_moved_on());
        assert!(app.show_segment(segment_page_fixture(1, None, None, false), vec![]));
        assert!(!app.live_moved_on());
        app.entries.push(turn("arrived"));
        assert!(app.live_moved_on());
    }
}
