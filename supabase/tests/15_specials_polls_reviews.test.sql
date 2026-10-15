-- Specials (server-priced, portions reserved atomically), polls (one vote, manager publishes),
-- reviews (+15 points, anonymous, staff reply), popular items (k ≥ 5).
-- Manager A …0002; kitchen A …0003; manager B …0004; students …0005 / …0006.
begin;
\ir _helpers.psql
select plan(33);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to anon, authenticated;
update public.pickup_slots set capacity = 50;

-- Specials -----------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.save_special('20000000-0000-4000-b000-00000000000a', '30000000-0000-4000-d000-000000000002',
  current_date, 20, 2) $$, 'CC403', null, 'another outlet''s manager cannot set specials');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ select app.save_special('20000000-0000-4000-b000-00000000000a', '30000000-0000-4000-d000-000000000004',
  current_date, 20, 2) $$, 'CC422', null, 'the item must be on this outlet''s menu');
select throws_ok($$ select app.save_special('20000000-0000-4000-b000-00000000000a', '30000000-0000-4000-d000-000000000002',
  current_date - 1, 20, 2) $$, 'CC422', null, 'not in the past');
-- Fixture sandwich is ₹70: 25% off → ₹52.50, 2 portions.
insert into t_ids values ('sp', app.save_special('20000000-0000-4000-b000-00000000000a', '30000000-0000-4000-d000-000000000002',
  (now() at time zone 'Asia/Kolkata')::date, 25, 2, 'Lunch deal'));
select tests.as_anon();
select results_eq($$ select unit_price_paise, discount_percent, portions_left from app.item_special('30000000-0000-4000-d000-000000000002') $$,
  $$ values (5250, 25, 2) $$, 'anyone can see today''s special price, computed by the server');
select tests.as_superuser();

insert into t_ids values
  ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":2}]', 'sp-o1-key'));
select results_eq($$ select unit_price_paise, line_total_paise, special_id is not null from public.order_items
  where order_id = (select id from t_ids where name = 'o1') $$, $$ values (5250, 10500, true) $$,
  'the order line is priced at the special');
select is((select portions_left from public.daily_specials where id = (select id from t_ids where name = 'sp')), 0,
  'and takes the portions');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok($$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
  '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'sp-o2-key', 'h') $$,
  'CC409', null, 'no portions left: the special can''t be oversold');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select app.transition_order((select id from t_ids where name = 'o1'), 'cancelled');
select tests.as_superuser();
select is((select portions_left from public.daily_specials where id = (select id from t_ids where name = 'sp')), 2,
  'cancelling gives the portions back');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ update public.daily_specials set discount_percent = 90 $$, '42501', null, 'specials change only through functions');

-- Polls ---------------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ select app.create_poll('20000000-0000-4000-b000-00000000000a', 'Tomorrow?',
  array['30000000-0000-4000-d000-000000000001']::uuid[], now() + interval '1 hour', current_date + 1, 20, 30) $$,
  'CC422', null, 'a poll needs at least two dishes');
insert into t_ids values ('poll', app.create_poll('20000000-0000-4000-b000-00000000000a', 'What should tomorrow''s special be?',
  array['30000000-0000-4000-d000-000000000001', '30000000-0000-4000-d000-000000000002']::uuid[],
  now() + interval '1 hour', ((now() at time zone 'Asia/Kolkata')::date + 1), 20, 30));
insert into t_ids select 'opt_chai', id from public.poll_options where menu_item_id = '30000000-0000-4000-d000-000000000001';
insert into t_ids select 'opt_sand', id from public.poll_options where menu_item_id = '30000000-0000-4000-d000-000000000002';

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select lives_ok($$ select app.vote((select id from t_ids where name = 'poll'), (select id from t_ids where name = 'opt_sand')) $$,
  'a student votes');
select throws_ok($$ select app.vote((select id from t_ids where name = 'poll'), (select id from t_ids where name = 'opt_chai')) $$,
  'CC409', 'You have already voted in this poll', 'one vote per student');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select app.vote((select id from t_ids where name = 'poll'), (select id from t_ids where name = 'opt_chai'));
select is_empty($$ select 1 from public.poll_votes where user_id <> auth.uid() $$, 'nobody sees who else voted');
select tests.as_anon();
select results_eq($$ select vote_count from public.poll_options where poll_id = (select id from t_ids where name = 'poll') order by sort_order $$,
  $$ values (1), (1) $$, 'live counts are public');
select throws_ok($$ select app.vote((select id from t_ids where name = 'poll'), (select id from t_ids where name = 'opt_chai')) $$,
  '42501', null, 'signed-out visitors cannot vote');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select app.publish_poll_winner((select id from t_ids where name = 'poll')) $$, 'CC403', null,
  'kitchen staff cannot publish the winner');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
-- A tie: the manager decides.
select lives_ok($$ select app.publish_poll_winner((select id from t_ids where name = 'poll'), (select id from t_ids where name = 'opt_chai')) $$,
  'the manager publishes their chosen winner');
select results_eq(
  $$ select p.status::text, s.menu_item_id, s.discount_percent::int, s.portions_total from public.polls p
     join public.daily_specials s on s.id = p.special_id where p.id = (select id from t_ids where name = 'poll') $$,
  $$ values ('published', '30000000-0000-4000-d000-000000000001'::uuid, 20, 30) $$,
  'the winner becomes tomorrow''s special with the configured discount'
);
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select ok(exists (select 1 from public.notifications where category = 'specials' and title like 'Poll result:%'),
  'voters are told the result');
select throws_ok($$ select app.vote((select id from t_ids where name = 'poll'), (select id from t_ids where name = 'opt_chai')) $$,
  'CC409', null, 'no voting after publishing');

-- Reviews ------------------------------------------------------------------------------------------
select tests.as_superuser();
insert into t_ids values
  ('o3', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'rv-o3-key'));
select tests.pay((select id from t_ids where name = 'o3'));
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.submit_review((select id from t_ids where name = 'o3'), 5, 5, 5, 5) $$,
  'CC409', null, 'an order can be reviewed only after pickup');
select tests.kitchen_ready((select id from t_ids where name = 'o3'));
-- Staff can't read pickup codes; take it as the superuser (the student would show it).
select set_config('test.code', (select code from public.order_pickup_codes where order_id = (select id from t_ids where name = 'o3')), true);
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select is(app.verify_pickup((select id from t_ids where name = 'o3'), current_setting('test.code')), 'completed',
  'the order is collected');
select tests.as_superuser();
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok($$ select app.submit_review((select id from t_ids where name = 'o3'), 1, 1, 1, 1) $$,
  'CC404', null, 'only the order''s owner can review it');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.submit_review((select id from t_ids where name = 'o3'), 6, 5, 5, 5) $$,
  'CC422', null, 'ratings are 1–5');
insert into t_ids values ('rv', app.submit_review((select id from t_ids where name = 'o3'), 5, 4, 3, 4, 'Great sandwich'));
select is((select points from public.loyalty_ledger where review_id = (select id from t_ids where name = 'rv')), 15,
  'a review earns 15 points');
select throws_ok($$ select app.submit_review((select id from t_ids where name = 'o3'), 5, 5, 5, 5) $$,
  'CC409', null, 'one review per order');
select tests.as_anon();
select results_eq($$ select taste, hygiene, speed, value, comment from public.reviews $$,
  $$ values (5::smallint, 4::smallint, 3::smallint, 4::smallint, 'Great sandwich') $$, 'reviews are public');
select throws_ok($$ select user_id from public.reviews $$, '42501', null, 'but who wrote them is not');
select results_eq($$ select review_count, overall from app.outlet_ratings() $$, $$ values (1, 4.00) $$,
  'the leaderboard averages the four dimensions');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.reply_to_review((select id from t_ids where name = 'rv'), 'Thanks!') $$,
  'CC404', null, 'another outlet''s staff cannot reply');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select lives_ok($$ select app.reply_to_review((select id from t_ids where name = 'rv'), 'Thank you, see you tomorrow!') $$,
  'the outlet''s kitchen replies');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select ok(exists (select 1 from public.notifications where title = 'The kitchen replied to your review'),
  'the student is told about the reply');

-- Popular with your classmates (k ≥ 5) ------------------------------------------------------------
select is_empty($$ select 1 from app.popular_items() $$, 'nothing is shown until at least 5 students ordered an item');

select * from finish();
rollback;
