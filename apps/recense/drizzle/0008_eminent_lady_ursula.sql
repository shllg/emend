ALTER TABLE `topics` ADD `attention` text CONSTRAINT `topics_attention_check` CHECK(`attention` in ('critical', 'review', 'skim'));
