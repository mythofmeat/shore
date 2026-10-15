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
